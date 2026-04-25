import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Session, Message, SessionMetadata } from './types.js';

export class SessionManager {
  private baseDir: string;

  constructor(customDir?: string) {
    // Follow the same pattern as config: project-local or home directory
    if (customDir) {
      this.baseDir = customDir;
    } else {
      const projectDir = path.join(process.cwd(), '.tiny-cli', 'sessions');
      const homeDir = path.join(os.homedir(), '.tiny-cli', 'sessions');
      
      // We'll check if project-local .tiny-cli exists
      this.baseDir = projectDir; // Default to project-local
    }
  }

  private async ensureDir() {
    try {
      await fs.mkdir(this.baseDir, { recursive: true });
    } catch (err) {
      // Ignore if exists
    }
  }

  async saveSession(session: Session): Promise<void> {
    await this.ensureDir();
    const filePath = path.join(this.baseDir, `${session.metadata.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
  }

  async loadSession(id: string): Promise<Session | null> {
    const filePath = path.join(this.baseDir, `${id}.json`);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as Session;
    } catch (err) {
      return null;
    }
  }

  async listSessions(): Promise<SessionMetadata[]> {
    await this.ensureDir();
    try {
      const files = await fs.readdir(this.baseDir);
      const sessions: SessionMetadata[] = [];
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.baseDir, file);
          const data = await fs.readFile(filePath, 'utf-8');
          const session = JSON.parse(data) as Session;
          sessions.push(session.metadata);
        }
      }
      
      return sessions.sort((a, b) => 
        new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime()
      );
    } catch (err) {
      return [];
    }
  }

  async deleteSession(id: string): Promise<void> {
    const filePath = path.join(this.baseDir, `${id}.json`);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      // Ignore if not found
    }
  }

  static createSession(id?: string, messages: Message[] = []): Session {
    const now = new Date().toISOString();
    const sessionId = id || crypto.randomUUID();
    return {
      metadata: {
        id: sessionId,
        createdAt: now,
        lastUpdatedAt: now,
      },
      messages
    };
  }
}
