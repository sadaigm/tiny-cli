import { checkBashBoundary, guardPath, resetSessionAllowed } from '../tools/bashGuard';
import type { AskUserPayload, AskUserResponse } from '../types';

const CWD = process.cwd();
const HOME = require('os').homedir();
const SCRATCH = `/tmp/${require('path').basename(CWD)}`;

/** askUser mock: answers the questionnaire with the given option. */
function askWith(choice: string) {
  return async (p: AskUserPayload): Promise<AskUserResponse> => ({
    kind: 'answered',
    answers: p.questions.map((q) => ({ question: q.question, selected: choice })),
  });
}
const askDeny = askWith('Deny');
const askOnce = askWith('Allow once');
const askSession = askWith('Allow for this session');
const noAsk = undefined;

beforeEach(() => resetSessionAllowed());

describe('checkBashBoundary — allow cases', () => {
  const allow: string[] = [
    'cat src/a.ts',
    `head -30 ${CWD}/ui/src/x.ts`,          // absolute but inside workspace
    'cd ui && npx tsc -b --pretty false',
    'ls src/hooks/ packages/',
    'node --version && npx jest --silent',
    `python3 -c "print(1+1)"`,
    'git status --short',
    'grep -n foo src/a.ts',
    `echo hi > ${SCRATCH}/scratch.txt`,      // project scratch
    `cat ${SCRATCH}/scratch.txt`,
    'mkdir -p build/out && touch build/out/a.js',
    '/usr/bin/env node -e "console.log(1)"', // executing toolchain binary
    'java -version',
  ];

  it.each(allow)('allows: %s', async (cmd) => {
    expect(await checkBashBoundary(cmd, CWD, noAsk)).toBeNull();
  });
});

describe('checkBashBoundary — block cases', () => {
  const cases: Array<[string, string]> = [
    // [command, expected key]
    [`cat ${HOME}/.gitconfig`, 'git-identity'], // sentinel via path — resolved to ask
    ['git config --global user.email', 'git-identity'],
    [`cat ${HOME}/.ssh/id_rsa`, 'secret'],
    ['ls ~/.aws', 'secret'],
    [`head ${HOME}/.nvm/versions/node/v20/lib/file.js`, 'toolchain-read'],
    ['grep foo /usr/lib/node_modules/x/index.js', 'toolchain-read'],
    [`cat ${HOME}/.config/Code/settings.json`, 'outside-workspace'],
    [`cd ${HOME} && cat secrets.txt`, 'outside-workspace'],
    ['cat /etc/passwd', 'outside-workspace'],
    [`find /home -name "*.env"`, 'outside-workspace'],
    ['echo data > /tmp/plain.txt', 'scratch-redirect'], // bare /tmp, not project scratch
  ];

  it.each(cases)('blocks: %s', async (cmd, key) => {
    const r = await checkBashBoundary(cmd, CWD, askDeny);
    expect(r?.key).toBe(key);
    if (key !== 'git-identity') expect(r?.message).toContain('NOT executed');
  });

  it('blocks .. traversal out of the workspace', async () => {
    const r = await checkBashBoundary(`cat ${CWD}/../../etc/hostname`, CWD, noAsk);
    expect(r?.key).toBe('outside-workspace');
  });

  it('blocks .. traversal out of project scratch', async () => {
    const r = await checkBashBoundary(`cat ${SCRATCH}/../../../etc/hostname`, CWD, noAsk);
    expect(r?.key).toBe('outside-workspace');
  });

  it('blocks secrets hidden in heredoc bodies (raw scan)', async () => {
    const cmd = `python3 - <<'EOF'\nprint(open("${HOME}/.ssh/id_rsa").read())\nEOF`;
    const r = await checkBashBoundary(cmd, CWD, noAsk);
    expect(r?.key).toBe('secret');
  });

  it('redirects bare /tmp to the project scratch dir', async () => {
    const r = await checkBashBoundary('head x > /tmp/vum.test.tsx', CWD, noAsk);
    expect(r?.key).toBe('scratch-redirect');
    expect(r?.message).toContain(SCRATCH);
  });
});

describe('checkBashBoundary — git identity consent', () => {
  it('denies without an ask channel (headless), every time', async () => {
    const r = await checkBashBoundary('git config --global user.email', CWD, noAsk);
    expect(r?.key).toBe('git-identity');
    const r2 = await checkBashBoundary('git config --global user.email', CWD, noAsk);
    expect(r2?.key).toBe('git-identity'); // never flips to allow silently
  });

  it('allows once on Allow once, but asks again next time', async () => {
    expect(await checkBashBoundary('git config --global user.email', CWD, askOnce)).toBeNull();
    // same choice again -> still asked (not session-cached)
    expect(await checkBashBoundary('git config --global user.name', CWD, askOnce)).toBeNull();
  });

  it('caches consent for the session on Allow for this session', async () => {
    expect(await checkBashBoundary('git config --global user.email', CWD, askSession)).toBeNull();
    // no ask channel, but session allowance holds
    expect(await checkBashBoundary('git config --global user.name', CWD, noAsk)).toBeNull();
  });

  it('denies on Deny', async () => {
    const r = await checkBashBoundary('git config --global user.email', CWD, askDeny);
    expect(r?.key).toBe('git-identity');
  });
});

describe('guardPath — dedicated file tools', () => {
  it('allows workspace paths (absolute, relative, bare)', () => {
    expect(guardPath(`${CWD}/src/a.ts`, CWD)).toBeNull();
    expect(guardPath('src/a.ts', CWD)).toBeNull();
    expect(guardPath('a.ts', CWD)).toBeNull();
  });

  it('allows project scratch', () => {
    expect(guardPath(`${SCRATCH}/x.txt`, CWD)).toBeNull();
  });

  it('blocks outside-workspace paths', () => {
    expect(guardPath(`${HOME}/.config/x.json`, CWD)).toContain('outside the project folder');
    expect(guardPath('/etc/passwd', CWD)).toContain('outside the project folder');
    expect(guardPath('../other-project/x.ts', CWD)).toContain('outside the project folder');
  });

  it('blocks secrets and git identity outright', () => {
    expect(guardPath(`${HOME}/.ssh/id_rsa`, CWD)).toContain('credentials');
    expect(guardPath(`${HOME}/.gitconfig`, CWD)).toContain('personal data');
  });
});
