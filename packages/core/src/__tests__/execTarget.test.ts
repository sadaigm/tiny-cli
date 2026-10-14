import { sq, wrapBashCmd, mapPath } from '../tools/execTarget.js';

describe('sq (single-quote wrap — sole new injection surface)', () => {
  it('wraps a plain command in single quotes', () => {
    expect(sq('ls -la')).toBe(`'ls -la'`);
  });

  it('neutralizes embedded single quotes (close, escape, reopen)', () => {
    expect(sq("echo 'hi'")).toBe(String.raw`'echo '\''hi'\'''`);
  });

  it('leaves $ expansions inert', () => {
    expect(sq('echo $HOME ${X}')).toBe(`'echo $HOME \${X}'`);
  });

  it('leaves command separators ; && || | inert', () => {
    expect(sq('a; b && c || d | e')).toBe(`'a; b && c || d | e'`);
  });

  it('handles backticks and subshells', () => {
    expect(sq('echo `id` $(id)')).toBe(`'echo \`id\` $(id)'`);
  });

  it('handles the empty string', () => {
    expect(sq('')).toBe(`''`);
  });

  it('handles unicode verbatim', () => {
    expect(sq('echo "héllo → 世界"')).toBe(`'echo "héllo → 世界"'`);
  });

  it('round-trips: wrapped output re-parsed by sh yields the original', () => {
    const original = `echo 'a'; rm -rf $HOME/\`pwd\` && echo "b"`;
    // sh -c "printf %s <sq(original)>" must print the original exactly.
    // Simulate the shell's single-quote semantics: 'x'\''y' concatenates x, ', y.
    const wrapped = sq(original);
    const unwrapped = wrapped.slice(1, -1).split(`'\\''`).join(`'`);
    expect(unwrapped).toBe(original);
  });

  it('wrapBashCmd embeds the sq-escaped command', () => {
    expect(wrapBashCmd({ kind: 'container', container: 'app-1' }, "echo 'hi'")).toBe(
      String.raw`docker exec -i app-1 /bin/bash -c 'echo '\''hi'\'''`
    );
    expect(wrapBashCmd({ kind: 'remote', host: 'srv', shell: '/bin/sh' }, 'pwd')).toBe(
      `ssh srv /bin/sh -c 'pwd'`
    );
  });
});

describe('mapPath (single-root mapping)', () => {
  const HOST = '/home/user/proj';

  it('blocks when root is absent (bash-only profile)', () => {
    const r = mapPath({ kind: 'container', container: 'c' }, '/app/f');
    expect(r.ok).toBe(false);
  });

  it('blocks when root has no resolvable host side (not bind-mounted)', () => {
    const r = mapPath({ kind: 'container', container: 'c', root: '/data' }, '/data/f');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('Use bash.');
  });

  it('maps an absolute path under root onto hostRoot', () => {
    const r = mapPath({ kind: 'container', container: 'c', root: '/app', hostRoot: HOST }, '/app/src/a.ts');
    expect(r).toEqual({ ok: true, hostPath: `${HOST}/src/a.ts` });
  });

  it('maps a relative path by resolving against root', () => {
    const r = mapPath({ kind: 'remote', host: 'h', root: '/srv/proj', hostRoot: HOST }, 'src/a.ts');
    expect(r).toEqual({ ok: true, hostPath: `${HOST}/src/a.ts` });
  });

  it('blocks paths outside root', () => {
    expect(mapPath({ kind: 'remote', host: 'h', root: '/srv/proj', hostRoot: HOST }, '/etc/passwd').ok).toBe(false);
    expect(mapPath({ kind: 'remote', host: 'h', root: '/srv/proj', hostRoot: HOST }, '../outside').ok).toBe(false);
  });

  it('blocks a root-adjacent prefix that is not actually under root', () => {
    expect(mapPath({ kind: 'container', container: 'c', root: '/app', hostRoot: HOST }, '/app2/x').ok).toBe(false);
  });
});
