import fs from 'fs/promises';
import path from 'path';
import { SessionManager } from '../session.js';

describe('SessionManager relative paths & sub-agent directories', () => {
  const testSubDir = 'test-session-123/sub';
  const expectedBase = path.join(process.cwd(), '.tiny-cli', 'sessions', testSubDir);

  afterAll(async () => {
    try {
      await fs.rm(path.join(process.cwd(), '.tiny-cli', 'sessions', 'test-session-123'), {
        recursive: true,
        force: true,
      });
    } catch {
      // ignore cleanup
    }
  });

  it('resolves relative customDir against default sessions root', () => {
    const sm = new SessionManager(testSubDir);
    expect(sm.getBaseDir()).toBe(expectedBase);
  });

  it('provides correct asset directory for a sub-agent id', () => {
    const sm = new SessionManager(testSubDir);
    const assetDir = sm.getAssetDir('456');
    expect(assetDir).toBe(path.join(expectedBase, '456'));
  });

  it('saves and loads a sub-agent session file using relative directory', async () => {
    const sm = new SessionManager(testSubDir);
    const subSession = SessionManager.createSession('456', [
      { role: 'user', content: 'Implement JWT middleware' },
      { role: 'assistant', content: 'JWT middleware created' },
    ]);

    await sm.saveSession(subSession);

    // Verify file actually exists at .tiny-cli/sessions/test-session-123/sub/456.json
    const filePath = path.join(expectedBase, '456.json');
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.metadata.id).toBe('456');
    expect(parsed.messages.length).toBe(2);

    // Verify loading through SessionManager
    const loaded = await sm.loadSession('456');
    expect(loaded).not.toBeNull();
    expect(loaded!.metadata.id).toBe('456');
    expect(loaded!.messages[0].content).toBe('Implement JWT middleware');
  });

  it('ensures asset directory exists on disk', async () => {
    const sm = new SessionManager(testSubDir);
    const assetDir = await sm.ensureAssetDir('456');
    const stat = await fs.stat(assetDir);
    expect(stat.isDirectory()).toBe(true);
  });
});

