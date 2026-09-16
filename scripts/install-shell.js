import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const bashrc = join(homedir(), '.bashrc');
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const marker = '# --- Kebiao MCP Launcher ---';
const block = `\n${marker}\nexport KEBIAO_DIR=${quote(root)}\n. ${quote(root + '/scripts/kebiao.bash')}\n# --- End Kebiao MCP Launcher ---\n`;
const previous = existsSync(bashrc) ? readFileSync(bashrc, 'utf8') : '';
if (previous.includes(marker)) {
  console.log('start_kebiao 已安装，无需重复修改。');
} else if (process.argv.includes('--dry-run')) {
  console.log(`将追加到 ${bashrc}：${block}`);
} else {
  if (previous.match(/^\s*(?:function\s+)?start_kebiao\s*\(/m)) throw new Error('已有自定义 start_kebiao，未覆盖');
  const mode = existsSync(bashrc) ? statSync(bashrc).mode & 0o777 : 0o600;
  if (existsSync(bashrc)) {
    const backup = `${bashrc}.kebiao-backup-${Date.now()}`;
    copyFileSync(bashrc, backup);
    console.log(`备份：${backup}`);
  }
  writeFileSync(bashrc, previous + block, {mode});
  console.log(`start_kebiao 已安装。新终端直接使用；当前终端执行 . ${root}/scripts/kebiao.bash。`);
}
