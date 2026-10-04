// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  version: string;
  auth: 'offline';
  connect: boolean;
}

export function parseConfig(): ServerConfig {
  return yargs(hideBin(process.argv))
    .version(false)
    .option('host', {
      type: 'string',
      description: 'Minecraft server host',
      default: 'localhost'
    })
    .option('port', {
      type: 'number',
      description: 'Minecraft server port',
      default: 25565
    })
    .option('username', {
      type: 'string',
      description: 'Bot username',
      default: 'LLMBot'
    })
    .option('version', { type: 'string', default: '1.21.1', description: 'Explicit Minecraft Java version (release validation: 1.21.1 / protocol 767)' })
    .option('auth', { choices: ['offline'] as const, default: 'offline' as const, description: 'Offline Minecraft identity; relay credentials stay in the separate user-controlled launcher' })
    .option('connect', { type: 'boolean', default: false, description: 'Explicit user-triggered Minecraft connection; never reconnects automatically' })
    .check(argv => { if (!Number.isInteger(argv.port) || argv.port < 1 || argv.port > 65535) throw new Error('Port must be an integer from 1 to 65535'); return true; })
    .help()
    .alias('help', 'h')
    .parseSync();
}
