import { checkBashRedirect, tokenize, recordRedirectCount, getRedirectCounts, resetRedirectCounts } from '../tools/bashRedirect';
import { buildGrepArgs } from '../tools/definitions';
import { ToolRegistry } from '../tools/registry';

describe('tokenize', () => {
  it('keeps quoted metacharacters as literal token content', () => {
    const tokens = tokenize('grep "a|b" src');
    expect(tokens[1]).toEqual({ text: 'a|b', unquotedMeta: false });
    expect(tokens.map((t) => t.text)).toEqual(['grep', 'a|b', 'src']);
  });

  it('flags unquoted shell syntax', () => {
    const tokens = tokenize('cat a | grep b');
    expect(tokens.find((t) => t.text === '|')?.unquotedMeta).toBe(true);
  });

  it('returns empty for empty input', () => {
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('checkBashRedirect — redirect cases', () => {
  const cases: Array<[string, string, string]> = [
    // [command, expected key, expected substring in the message]
    ['cat src/app.ts', 'cat->read', '"path":"src/app.ts"'],
    ['cat a.ts b.ts', 'cat->read', '2 files'],
    ['head -50 log.txt', 'head->read', '"endLine":50'],
    ['head -n 20 f.ts', 'head->read', '"endLine":20'],
    ['head f.ts', 'head->read', '"first250":true'],
    ['tail f.ts', 'tail->read', '"last100":true'],
    ['tail -n 5 f.ts', 'tail->read', 'last 5'],
    ['ls', 'ls->list', '"path":"."'],
    ['ls -la src', 'ls->list', '"path":"src"'],
    ['find . -name "*.ts"', 'find->glob', '"pattern":"**/*.ts"'],
    ['find src -name "*.test.ts"', 'find->glob', '"pattern":"src/**/*.test.ts"'],
    ['grep foo', 'grep->grep', '"pattern":"foo"'],
    ['grep -rn foo src', 'grep->grep', '"path":"src"'],
    ['grep -rnE "a|b" packages', 'grep->grep', '"path":"packages"'],
    ['grep --include=*.ts -rn foo .', 'grep->grep', '"path":"."'],
    ['rg pattern src', 'grep->grep', '"pattern":"pattern"'],
    ["sed -n '100,150p' file.ts", 'sed-n->read', '"startLine":100'],
    ['sed -n 20,30p file.ts', 'sed-n->read', '"startLine":20'],
    ["sed -i 's/a/b/' file.ts", 'sed-i->search_replace', '"path":"file.ts"'],
    ['echo hi > f.txt', 'echo>-write', '"path":"f.txt"'],
    ["printf 'x\\n' >> log", 'echo>-write', '"path":"log"'],
    ['echo $(date) > f', 'echo>-write', '"path":"f"'],
  ];

  it.each(cases)('%s -> %s', (cmd, key, fragment) => {
    const result = checkBashRedirect(cmd);
    expect(result).not.toBeNull();
    expect(result!.key).toBe(key);
    expect(result!.message).toContain(fragment);
    expect(result!.message).toContain('NOT executed');
    expect(result!.message).toContain('Re-issue as:');
  });
});

describe('checkBashRedirect — allowed cases (real shell work)', () => {
  const allowed = [
    'cat a.ts | grep b',            // pipeline
    'git status',
    'cd src && cat a.ts',           // chained
    'npm test 2>&1 | tail -20',     // redirection + pipe
    'node script.js > out.log',     // redirect, but not an echo write
    'grep -i foo src',              // case-insensitive: dedicated tool can't
    'grep -C 3 foo src',            // context lines: dedicated tool can't
    "sed 's/a/b/' f.ts",            // stdout transform, harmless
    'find . -type d',               // no -name: no glob equivalent
    'find . -name "*.ts" -delete',  // mutation via find: let permission system see it
    'head -c 100 f.ts',             // byte count: no read equivalent
    'wc -l file.ts',
    'mkdir -p a/b',
    'echo hello',                   // plain echo, no redirect
    'cat',                          // no operand (stdin) — leave alone
    'diff a b',
    'rg -i pattern',                // unsupported rg flag
    '   ',
  ];

  it.each(allowed.map((c) => [c]))('%s -> allowed', (cmd) => {
    expect(checkBashRedirect(cmd)).toBeNull();
  });
});

describe('redirect counts', () => {
  beforeEach(() => resetRedirectCounts());

  it('counts and sorts redirect occurrences', () => {
    recordRedirectCount('cat->read');
    recordRedirectCount('cat->read');
    recordRedirectCount('ls->list');
    const counts = getRedirectCounts();
    expect(counts).toEqual({ 'cat->read': 2, 'ls->list': 1 });
    expect(Object.keys(counts)[0]).toBe('cat->read'); // sorted by count desc
  });
});

describe('buildGrepArgs', () => {
  it('filters excludes and extensions by default', () => {
    const args = buildGrepArgs('foo', '/repo/src');
    expect(args[0]).toBe('-rInE');
    expect(args).toContain('--exclude-dir=node_modules');
    expect(args).toContain('--exclude-dir=dist');
    expect(args).toContain('--exclude-dir=.git');
    expect(args).toContain('--include=*.ts');
    expect(args).toContain('--include=*.py');
    expect(args.slice(-2)).toEqual(['foo', '/repo/src']);
  });

  it('includeExcluded searches everything', () => {
    expect(buildGrepArgs('foo', '/repo', true)).toEqual(['-rInE', 'foo', '/repo']);
  });
});

describe('ToolRegistry usage stats', () => {
  it('counts calls per tool', async () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'dummy', description: 'd', parameters: { type: 'object', properties: {} } }, async () => 'ok');
    await registry.call('dummy', {});
    await registry.call('dummy', {});
    expect(registry.getUsageStats()).toEqual({ dummy: 2 });
  });
});
