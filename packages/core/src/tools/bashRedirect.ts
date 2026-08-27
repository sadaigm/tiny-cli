/**
 * Runtime tool-routing enforcement.
 *
 * Models have a strong prior toward shell commands (cat/grep/find/ls/sed), and
 * tool-description guidance alone loses to the "one bash call chains
 * everything" incentive. Those commands also bypass the dedicated tools'
 * curated output (excludes, truncation, line numbers) and — for sed -i /
 * `echo >` — mutate files invisibly, outside the permission/diff machinery.
 * So: single-purpose read/search/locate/edit commands are intercepted and
 * refused with a redirect to the dedicated tool. The refused turn is the
 * training signal; the model re-issues the call properly within one step.
 *
 * Conservative by design: only PLAIN commands redirect. Anything with unquoted
 * shell metacharacters (| ; && > $( ) ...) is a chain/substitution and always
 * runs — real shell work is never blocked.
 */

const SHELL_META = new Set(['|', '&', ';', '>', '<', '(', ')', '$', '`']);

type Token = { text: string; unquotedMeta: boolean };

/** Split on whitespace outside single/double quotes; flag tokens that contain
 *  unquoted shell metacharacters (i.e. real shell syntax, not a quoted value
 *  like the pattern in `grep "a|b" file`). */
export function tokenize(cmd: string): Token[] {
  const tokens: Token[] = [];
  let cur: Token | null = null;
  let quote = '';
  for (const ch of cmd.trim()) {
    if (quote) {
      if (ch === quote) quote = '';
      else {
        cur = cur ?? { text: '', unquotedMeta: false };
        cur.text += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur = cur ?? { text: '', unquotedMeta: false };
    } else if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = null; }
    } else {
      cur = cur ?? { text: '', unquotedMeta: false };
      if (SHELL_META.has(ch)) cur.unquotedMeta = true;
      cur.text += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

export type BashRedirectResult = { key: string; message: string };

function redirect(
  key: string,
  tool: string,
  args?: Record<string, unknown>,
  note?: string,
): BashRedirectResult {
  const argsStr = args && Object.keys(args).length ? ` ${JSON.stringify(args)}` : '';
  const lines = [
    `TOOL REDIRECT: this bash command duplicates the dedicated \`${tool}\` tool, so it was NOT executed.`,
  ];
  if (note) lines.push(note);
  lines.push(`Re-issue as: ${tool}${argsStr}`);
  lines.push(
    'Dedicated tools are faster, skip the permission gate, and return cleaner output. ' +
      'Use bash only for real shell work (git, build, test, install, pipelines).',
  );
  return { key, message: lines.join('\n') };
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function isFlag(t: Token): boolean {
  return t.text.startsWith('-') && t.text !== '-' && !/^-[\d.,]+$/.test(t.text);
}

function operandsOf(argv: Token[]): string[] {
  return argv.filter((t) => !isFlag(t)).map((t) => t.text);
}

/**
 * Detect a bash command that duplicates a dedicated tool.
 * Returns a redirect result (caller must NOT execute the command), or null to
 * allow the command through unchanged.
 */
export function checkBashRedirect(cmd: string): BashRedirectResult | null {
  const tokens = tokenize(cmd);
  if (tokens.length === 0) return null;

  // Chained / substituted / redirected command: only intercept the pure
  // `echo|printf > file` write form; everything else is real shell work.
  if (tokens.some((t) => t.unquotedMeta)) {
    return checkWriteRedirect(tokens);
  }

  const program = basename(tokens[0].text);
  const argv = tokens.slice(1);

  switch (program) {
    case 'cat': {
      const files = operandsOf(argv);
      if (files.length === 0) return null; // stdin reader — leave it alone
      return redirect(
        'cat->read',
        'read',
        { path: files[0] },
        files.length > 1 ? `${files.length} files were given; read them one at a time (first shown above).` : undefined,
      );
    }

    case 'head':
    case 'tail': {
      // Byte-based modes (`-c`) and other exotic flags have no equivalent.
      const flagText = argv.filter(isFlag).map((t) => t.text).join(' ');
      if (/(^|\s)-{1,2}[a-z-]*c/.test(flagText)) return null;
      // Extract `-N` / `-n N` / `-nN`; keep the rest as operands.
      let n: number | undefined;
      const rest: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        const t = argv[i].text;
        const m = /^-n(\d+)?$/.exec(t);
        if (m) {
          n = m[1] ? Number(m[1]) : Number(argv[++i]?.text);
          continue;
        }
        if (/^-\d+$/.test(t)) { n = Number(t.slice(1)); continue; }
        if (isFlag(argv[i])) continue;
        rest.push(t);
      }
      const file = rest[0];
      if (!file) return null;
      if (program === 'head') {
        return redirect(
          'head->read',
          'read',
          n ? { path: file, startLine: 1, endLine: n } : { path: file, first250: true },
        );
      }
      return redirect(
        'tail->read',
        'read',
        { path: file, last100: true },
        n ? `read has no last-N option; last100 covers it (you asked for the last ${n}).` : undefined,
      );
    }

    case 'ls': {
      return redirect('ls->list', 'list', { path: operandsOf(argv)[0] || '.' });
    }

    case 'find': {
      // -exec/-delete are mutations; other predicates have no glob equivalent.
      const argvText = argv.map((t) => t.text);
      if (['-exec', '-execdir', '-ok', '-okdir', '-delete'].some((f) => argvText.includes(f))) return null;
      let name: string | undefined;
      for (let i = 0; i < argv.length; i++) {
        const t = argv[i].text;
        if (t === '-name' || t === '-iname') { name = argv[i + 1]?.text; break; }
      }
      if (!name) return null;
      // find -name matches at ANY depth -> mirror that with `**`.
      const startDir = operandsOf(argv).find((o) => o !== name && o !== '.') || '';
      const pattern = startDir ? `${startDir}/**/${name}` : `**/${name}`;
      return redirect(
        'find->glob',
        'glob',
        { pattern },
        `find -name matches at any depth, so the glob uses ** (from ${startDir || 'the project root'}).`,
      );
    }

    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'rg': {
      // Only redirect flags our `grep` tool can express (r/n/E/I plus the
      // include/exclude filters). -i/-v/-l/-A/-B/-C etc. run in bash.
      for (const t of argv) {
        if (!isFlag(t)) continue;
        const s = t.text;
        if (s.startsWith('--')) {
          if (!/^(--include|--exclude|--exclude-dir|--color)=/.test(s) && s !== '--color') return null;
          continue;
        }
        const chars = s.replace(/^-+/, '');
        if ([...chars].some((c) => !'rnEI'.includes(c))) return null;
      }
      const vals = argv.filter((t) => !isFlag(t)).map((t) => t.text);
      if (vals.length === 0) return null;
      const pattern = vals[0];
      const target = vals[1];
      return redirect(
        'grep->grep',
        'grep',
        target ? { pattern, path: target } : { pattern },
        vals.length > 2 ? `${vals.length - 1} targets given; searching the first — narrow it or grep them one by one.` : undefined,
      );
    }

    case 'sed': {
      const inPlace = argv.some((t) => {
        const s = t.text;
        if (s.startsWith('--')) return s === '--in-place' || s.startsWith('--in-place=');
        return /^-[A-Za-z]/.test(s) && s.includes('i');
      });
      const ops = operandsOf(argv);
      const script = ops[0];
      const file = ops[ops.length - 1];
      if (inPlace) {
        if (!file || file === script) return null;
        return redirect(
          'sed-i->search_replace',
          'search_replace',
          { path: file },
          `\`sed -i\` edits files invisibly — no diff, no permission granularity. Translate the expression \`${script}\` into an exact \`search\` block + \`replace\` text and call search_replace.`,
        );
      }
      // `sed -n 'A,Bp' FILE` is just a ranged read.
      const m = /^(\d+)(?:,(\d+))?p$/.exec(script ?? '');
      if (m && file && file !== script) {
        const startLine = Number(m[1]);
        return redirect('sed-n->read', 'read', {
          path: file,
          startLine,
          endLine: m[2] ? Number(m[2]) : startLine,
        });
      }
      return null; // plain stdout transform — harmless, allow
    }

    default:
      return null;
  }
}

/** `echo|printf ... > file` writes a file via shell — route to `write` so the
 *  mutation goes through the normal tool path. Other meta-using commands pass. */
function checkWriteRedirect(tokens: Token[]): BashRedirectResult | null {
  const program = basename(tokens[0].text);
  if (program !== 'echo' && program !== 'printf') return null;
  const idx = tokens.findIndex((t) => t.unquotedMeta && (t.text === '>' || t.text === '>>'));
  if (idx === -1) return null;
  const file = tokens[idx + 1];
  if (!file) return null;
  return redirect('echo>-write', 'write', { path: file.text });
}

// --- usage tally (layer D): how often each redirect fired this process ---

const redirectCounts = new Map<string, number>();

export function recordRedirectCount(key: string) {
  redirectCounts.set(key, (redirectCounts.get(key) || 0) + 1);
}

export function getRedirectCounts(): Record<string, number> {
  return Object.fromEntries([...redirectCounts.entries()].sort((a, b) => b[1] - a[1]));
}

export function resetRedirectCounts() {
  redirectCounts.clear();
}
