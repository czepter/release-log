import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { log } from './db/schema.ts';
import { fakeGitHub, blobSha } from './github.ts';
import type { GitHub, RepoRef, CreateUserRepo } from './github.ts';
import { fakeHttp } from './http.ts';
import { cipher } from './secrets.ts';
import { userTokens } from './userTokens.ts';
import { syncLog } from './index.ts';
import { createLog, adoptLog, newLogId } from './createLog.ts';

const KEY = Buffer.alloc(32, 8);

// Ein GitHub, das sich merkt, was in es hineingeschrieben wird: probe,
// tree und blob von fakeGitHub lesen denselben repos-Baum, den createRepo
// und putFile füllen. Nur so lässt sich die eigentliche Behauptung prüfen
// -- am Ende steht ein indizierter Log -- statt nur die Aufrufreihenfolge
// nachzuzählen.
function recordingGitHub(): { gh: GitHub; repos: Record<string, Record<string, string | Buffer>>; commits: string[] } {
  const repos: Record<string, Record<string, string | Buffer>> = {};
  const commits: string[] = [];
  const base = fakeGitHub(repos);
  return {
    repos,
    commits,
    gh: {
      ...base,
      async putFile(ref, path, content) {
        const key = `${ref.owner}/${ref.repo}`;
        if (!repos[key]) return { kind: 'no_installation' };
        if (repos[key][path] !== undefined) return { kind: 'conflict' };
        repos[key][path] = content;
        commits.push(path);
        return { kind: 'committed', sha: blobSha(content) };
      },
    },
  };
}

type Harness = {
  db: ReturnType<typeof openDb>;
  gh: GitHub;
  repos: Record<string, Record<string, string | Buffer>>;
  commits: string[];
  users: ReturnType<typeof userTokens>;
  createRepo: CreateUserRepo;
  createRepoCalls: Array<{ token: string; name: string; private: boolean; description: string }>;
  syncNow: (ref: RepoRef) => Promise<void>;
  baseUrl: string;
  maxLogsPerOwner: number;
};

function withHarness(
  fn: (h: Harness) => Promise<void>,
  createRepo?: CreateUserRepo,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-createlog-'));
  const db = openDb(join(dir, 'test.sqlite'));
  const { gh, repos, commits } = recordingGitHub();
  const users = userTokens({
    db, http: fakeHttp({}), cipher: cipher(KEY), clientId: 'Iv1.test', clientSecret: 'secret',
  });
  const createRepoCalls: Harness['createRepoCalls'] = [];
  const recordingCreate: CreateUserRepo = async (token, input) => {
    createRepoCalls.push({ token, name: input.name, private: input.private, description: input.description });
    if (createRepo) return createRepo(token, input);
    repos[`octocat/${input.name}`] = {};
    return { kind: 'created', owner: 'octocat', repo: input.name, nodeId: `R_${input.name}` };
  };
  return fn({
    db, gh, repos, commits, users, createRepo: recordingCreate, createRepoCalls,
    syncNow: async (ref) => { await syncLog(db, gh, ref); },
    baseUrl: 'https://example.test',
    maxLogsPerOwner: 10,
  }).finally(() => { rmSync(dir, { recursive: true, force: true }); });
}

const GRANTED = {
  accessToken: 'gho_user_token',
  accessExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
  refreshToken: 'ghr_stored',
  refreshExpiresAt: new Date(Date.now() + 181 * 24 * 60 * 60 * 1000).toISOString(),
};

const INPUT = {
  accountId: 42, login: 'octocat', owner: 'octocat',
  repoName: 'auri-release-log', product: 'Auri CRM',
};

test('a new log ends up created, written, indexed and reachable', async () => {
  await withHarness(async (h) => {
    h.users.store(42, GRANTED);
    const result = await createLog(h, INPUT);
    assert.equal(result.ok, true, result.ok ? '' : `${result.error}: ${result.message}`);
    if (!result.ok) return;

    // Das Repo entstand mit dem NUTZER-Token -- POST /user/repos gibt es
    // nur damit (Entscheidung 23).
    assert.deepEqual(h.createRepoCalls, [{
      token: 'gho_user_token', name: 'auri-release-log', private: false, description: 'Release-Log: Auri CRM',
    }]);
    // Beide Dateien kamen danach, über das Installations-Token.
    assert.deepEqual(h.commits, ['release-log.json', 'README.md']);
    const written = JSON.parse(String(h.repos['octocat/auri-release-log']['release-log.json']));
    assert.deepEqual(written, {
      id: result.value.logId, product: 'Auri CRM', view: 'full', visibility: 'public', curation_notes: null,
    });

    // Und der Index kennt ihn, bevor die Antwort herausgeht: die URL in der
    // Antwort darf nicht auf eine 404 zeigen.
    const row = h.db.select().from(log).all()[0];
    assert.equal(row.publicId, result.value.logId);
    assert.equal(row.product, 'Auri CRM');
    assert.equal(row.repoOwner, 'octocat');
    assert.equal(row.repoName, 'auri-release-log');
    assert.equal(result.value.url, `https://example.test/l/${result.value.logId}`);
  });
});

test('view and visibility reach both the document and the repository', async () => {
  await withHarness(async (h) => {
    h.users.store(42, GRANTED);
    const result = await createLog(h, { ...INPUT, view: 'timeline', visibility: 'private' });
    assert.equal(result.ok, true);
    const written = JSON.parse(String(h.repos['octocat/auri-release-log']['release-log.json']));
    assert.equal(written.view, 'timeline');
    assert.equal(written.visibility, 'private');
    assert.equal(h.createRepoCalls[0].private, true, 'a private log belongs in a private repository');
  });
});

test('an unknown view is refused by the same validator the index uses', async () => {
  await withHarness(async (h) => {
    h.users.store(42, GRANTED);
    const result = await createLog(h, { ...INPUT, view: 'gallery' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'invalid_document');
    assert.equal(h.createRepoCalls.length, 0, 'nothing may be created for a document that would not validate');
  });
});

test('a repository name GitHub would not take is refused before anything is created', async () => {
  await withHarness(async (h) => {
    h.users.store(42, GRANTED);
    for (const repoName of ['', 'has spaces', 'a/b', '.hidden', 'a'.repeat(101)]) {
      const result = await createLog(h, { ...INPUT, repoName });
      assert.equal(result.ok, false, `"${repoName}" must be refused`);
      if (result.ok) return;
      assert.equal(result.error, 'invalid_document');
    }
    assert.equal(h.createRepoCalls.length, 0);
  });
});

test('creating on someone else\'s account is refused, not attempted', async () => {
  // POST /user/repos legt nur auf dem eigenen Konto an. Ein Aufruf mit
  // fremdem owner landete sonst wortlos woanders.
  await withHarness(async (h) => {
    h.users.store(42, GRANTED);
    const result = await createLog(h, { ...INPUT, owner: 'some-org' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'forbidden');
    assert.match(result.message, /octocat/);
    assert.equal(h.createRepoCalls.length, 0);
  });
});

test('without a stored user token the answer names the way back', async () => {
  await withHarness(async (h) => {
    const result = await createLog(h, INPUT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'reauth_required');
    assert.match(result.message, /\/auth\/github\/login/);
    assert.equal(h.createRepoCalls.length, 0);
  });
});

test('a taken repository name comes back as a conflict, naming it', async () => {
  await withHarness(async (h) => {
    h.users.store(42, GRANTED);
    const result = await createLog(h, INPUT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'conflict');
    assert.match(result.message, /auri-release-log/);
  }, async () => ({ kind: 'name_taken' }));
});

test('a user token GitHub refuses is thrown away, and the answer says to sign in again', async () => {
  await withHarness(async (h) => {
    h.users.store(42, GRANTED);
    const result = await createLog(h, INPUT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'reauth_required');
    // Weggeworfen, nicht behalten: ein Token, das GitHub ablehnt, kostet
    // sonst bei jedem weiteren Versuch einen vergeblichen Umlauf.
    assert.deepEqual(await h.users.tokenFor(42), { ok: false, error: 'reauth_required' });
  }, async () => ({ kind: 'unauthorized' }));
});

test('GitHub failing on the creation itself is reported as unavailable, not as a wrong name', async () => {
  await withHarness(async (h) => {
    h.users.store(42, GRANTED);
    const result = await createLog(h, INPUT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'github_unavailable');
    assert.match(result.message, /502/);
  }, async () => ({ kind: 'unavailable', status: 502 }));
});

test('a repository the installation cannot see stops before the first commit', async () => {
  // repository_selection=selected: das frisch angelegte Repo gehört noch
  // nicht zur Auswahl. Blind weiterzuschreiben ergäbe einen Log, den der
  // Index nie zu sehen bekommt (spec §6).
  await withHarness(async (h) => {
    h.users.store(42, GRANTED);
    const result = await createLog(h, INPUT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'repo_not_installed');
    assert.match(result.message, /github\.com\/settings\/installations/);
    assert.deepEqual(h.commits, [], 'nothing may be committed into a repository the app cannot read back');
    assert.equal(h.db.select().from(log).all().length, 0);
  }, async (_token, input) => ({ kind: 'created', owner: 'octocat', repo: input.name, nodeId: 'R_invisible' }));
});

test('a README that will not commit does not sink the log', async () => {
  // Die README ist Beiwerk. Ein Abbruch hier ließe ein fertiges Repo wie
  // einen Fehlschlag aussehen -- und der Log steht ja.
  await withHarness(async (h) => {
    h.users.store(42, GRANTED);
    const stubborn: GitHub = {
      ...h.gh,
      async putFile(ref, path, content, message, sha) {
        if (path === 'README.md') throw new Error('GitHub said no');
        return h.gh.putFile(ref, path, content, message, sha);
      },
    };
    const result = await createLog({ ...h, gh: stubborn, syncNow: async (ref) => { await syncLog(h.db, stubborn, ref); } }, INPUT);
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    assert.equal(h.db.select().from(log).all().length, 1);
  });
});

test('every generated id is URL-safe, and two of them differ', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const id = newLogId();
    assert.match(id, /^[0-9a-hjkmnp-tv-z]{12}$/, `${id} must be lowercase Crockford base32`);
    ids.add(id);
  }
  assert.equal(ids.size, 200, 'ids must not repeat');
});

// Ein bestehendes Repo übernehmen (spec §8): trägt es schon eine
// release-log.json, gilt deren id; sonst schreibt die App eine mit frischer
// id. Nie ein neues Repo, nie eine README über eine fremde.
const ADOPT = { accountId: 42, login: 'octocat', owner: 'octocat', repoName: 'shop', product: 'Shop' };

test('adopting a repository without release-log.json writes one and indexes it, and touches nothing else', async () => {
  await withHarness(async (h) => {
    h.repos['octocat/shop'] = { 'README.md': '# my own readme\n', 'releases/1.0.0.json': JSON.stringify({ version: '1.0.0', date: '2026-01-01', published_at: null, headline: 'first' }) };
    const result = await adoptLog(h, { ...ADOPT, view: 'timeline' });
    assert.equal(result.ok, true, result.ok ? '' : `${result.error}: ${result.message}`);
    if (!result.ok) return;
    assert.deepEqual(h.createRepoCalls, [], 'no repository is created');
    assert.deepEqual(h.commits, ['release-log.json'], 'only the config is written, the README stays the owner\'s');
    const written = JSON.parse(String(h.repos['octocat/shop']['release-log.json']));
    assert.deepEqual(written, { id: result.value.logId, product: 'Shop', view: 'timeline', visibility: 'public', curation_notes: null });
    const row = h.db.select().from(log).all()[0];
    assert.equal(row.publicId, result.value.logId);
    assert.equal(row.repoName, 'shop');
    assert.equal(result.value.url, `https://example.test/l/${result.value.logId}`);
  });
});

test('adopting an empty repository writes the config into it', async () => {
  await withHarness(async (h) => {
    h.repos['octocat/shop'] = {};
    const result = await adoptLog(h, ADOPT);
    assert.equal(result.ok, true, result.ok ? '' : `${result.error}: ${result.message}`);
    assert.deepEqual(h.commits, ['release-log.json']);
  });
});

test('adopting a repository that already carries a valid release-log.json keeps its id and writes nothing', async () => {
  await withHarness(async (h) => {
    h.repos['octocat/shop'] = { 'release-log.json': JSON.stringify({ id: 'existing-id', product: 'Shop Classic', view: 'full', visibility: 'public' }) };
    const result = await adoptLog(h, { ...ADOPT, product: 'Form Name' });
    assert.equal(result.ok, true, result.ok ? '' : `${result.error}: ${result.message}`);
    if (!result.ok) return;
    assert.equal(result.value.logId, 'existing-id');
    assert.deepEqual(h.commits, []);
    assert.equal(h.db.select().from(log).all()[0].product, 'Shop Classic', 'the file wins over the form');
  });
});

test('adopting a repository whose release-log.json is broken is refused with the validator\'s reasons', async () => {
  await withHarness(async (h) => {
    h.repos['octocat/shop'] = { 'release-log.json': JSON.stringify({ product: 'no id' }) };
    const result = await adoptLog(h, ADOPT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'invalid_document');
    assert.match(result.message, /config\.id/);
    assert.deepEqual(h.commits, []);
  });
});

test('adopting needs write access on the repository, not just visibility', async () => {
  await withHarness(async (h) => {
    h.repos['octocat/shop'] = {};
    h.gh = { ...h.gh, collaboratorPermission: async () => 'read' };
    const result = await adoptLog(h, ADOPT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'forbidden');
    assert.deepEqual(h.commits, []);
  });
});

test('adopting a repository that already has a log is a conflict', async () => {
  await withHarness(async (h) => {
    h.repos['octocat/shop'] = {};
    assert.equal((await adoptLog(h, ADOPT)).ok, true);
    const again = await adoptLog(h, ADOPT);
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.error, 'conflict');
    assert.match(again.message, /already has a release log/);
    assert.equal(h.commits.length, 1, 'the second attempt writes nothing');
  });
});

test('adopting a repository whose release-log.json id belongs to another log is a conflict', async () => {
  await withHarness(async (h) => {
    h.repos['octocat/first'] = { 'release-log.json': JSON.stringify({ id: 'same-id', product: 'First' }) };
    await h.syncNow({ owner: 'octocat', repo: 'first' });
    h.repos['octocat/shop'] = { 'release-log.json': JSON.stringify({ id: 'same-id', product: 'Copy' }) };
    const result = await adoptLog(h, ADOPT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'conflict');
    assert.match(result.message, /same-id/);
  });
});

test('adopting a repository the installation cannot see is repo_not_installed', async () => {
  await withHarness(async (h) => {
    const result = await adoptLog(h, ADOPT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'repo_not_installed');
  });
});

test('adopting on someone else\'s account is refused, not attempted', async () => {
  await withHarness(async (h) => {
    h.repos['some-org/shop'] = {};
    const result = await adoptLog(h, { ...ADOPT, owner: 'some-org' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'forbidden');
  });
});

test('createLog lehnt ab, sobald das Konto seine Grenze erreicht hat, und legt kein Repo an', async () => {
  await withHarness(async (h) => {
    h.users.store(42, GRANTED);
    const limited = { ...h, maxLogsPerOwner: 1 };

    const first = await createLog(limited, INPUT);
    assert.equal(first.ok, true, first.ok ? '' : `${first.error}: ${first.message}`);
    const callsAfterFirst = h.createRepoCalls.length;

    const second = await createLog(limited, { ...INPUT, repoName: 'zweites-log' });
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.error, 'forbidden');
    assert.match(second.message, /already has 1 logs/);
    assert.equal(h.createRepoCalls.length, callsAfterFirst, 'GitHub wurde nicht gefragt');
  });
});

test('createLog ohne Grenze (0) legt weiter an', async () => {
  await withHarness(async (h) => {
    h.users.store(42, GRANTED);
    const open = { ...h, maxLogsPerOwner: 0 };
    assert.equal((await createLog(open, INPUT)).ok, true);
    const second = await createLog(open, { ...INPUT, repoName: 'zweites-log' });
    assert.equal(second.ok, true, second.ok ? '' : `${second.error}: ${second.message}`);
  });
});

test('adoptLog zählt gegen dieselbe Grenze und schreibt dann nichts ins Repo', async () => {
  await withHarness(async (h) => {
    h.repos['octocat/shop'] = {};
    const limited = { ...h, maxLogsPerOwner: 1 };

    const first = await adoptLog(limited, ADOPT);
    assert.equal(first.ok, true, first.ok ? '' : `${first.error}: ${first.message}`);
    const commitsAfterFirst = [...h.commits];

    h.repos['octocat/zweites'] = {};
    const second = await adoptLog(limited, { ...ADOPT, repoName: 'zweites' });
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.error, 'forbidden');
    assert.deepEqual(h.commits, commitsAfterFirst, 'nichts wurde ins Repo geschrieben');
  });
});
