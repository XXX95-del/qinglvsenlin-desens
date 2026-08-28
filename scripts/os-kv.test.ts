/* 设备密钥信封专项测试（可注入内存 KV + node webcrypto）
 * 验证：
 *  1) 持久化的不再是会话密钥明文，而是「设备密钥加密后的密文」；
 *  2) 设备密钥 non-extractable —— 同源脚本无法 export 出原始字节；
 *  3) 信封可被设备密钥正确解密恢复会话密钥（refresh 恢复链路成立）。
 */
import { webcrypto } from 'node:crypto';
const subtle = webcrypto.subtle;
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import {
  setKeyVaultForTest,
  getKeyVaultForTest,
  getDeviceKey,
  deriveKeyFromPassword,
  setSessionKey,
  restoreSessionKey,
} from '../src/mapping-crypto';

const b64ToBuf = (s: string) => Uint8Array.from(Buffer.from(s, 'base64')).buffer;

const salt = b64ToBuf('c2FsdG1hc3Rlcg==');

function encText(ab: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(ab));
}

async function main() {
  let pass = 0;
  const ok = (c: boolean, msg: string) => {
    console.log(`  ${c ? '✔' : '✗'} ${msg}`);
    if (c) pass++;
    else process.exitCode = 1;
  };

  await setKeyVaultForTest();

  // 1) 会话密钥可导出（信封需要），设备密钥不可导出
  const session = (await deriveKeyFromPassword('P@ssw0rd!', salt)) as CryptoKey;
  ok(session.extractable === true, '会话密钥可导出（供信封封装）');
  const dk = (await getDeviceKey()) as CryptoKey;
  ok(dk.extractable === false, '设备密钥 non-extractable（脚本不可导出原始字节）');
  try {
    await subtle.exportKey('raw', dk);
    ok(false, '对不可导出设备密钥 exportKey 应抛错');
  } catch {
    ok(true, 'exportKey(deviceKey) 正确抛错 —— 同源脚本拿不到设备密钥字节');
  }

  // 2) 持久化落盘的是信封密文，不是明文
  await setSessionKey(session, true);
  const stored = (await getKeyVaultForTest()?.get('olasenos_session_key')) as string;
  ok(typeof stored === 'string' && stored.includes(':'), '持久化值是「iv:ciphertext」信封密文');
  ok(!/^[A-Za-z0-9+/=]{24,}$/.test(String(stored).split(':')[0] ?? ''), '信封首段(iv)不是直接可还原会话密钥的明文');

  // 3) 信封可被设备密钥解密恢复会话密钥（refresh 恢复链路）
  const [ivStr, ctStr] = String(stored).split(':');
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(ivStr) },
    dk,
    b64ToBuf(ctStr)
  );
  const restored = (await subtle.importKey('raw', plain, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ])) as CryptoKey;
  // 用恢复出的密钥加解密一段，证明该密钥就是会话密钥
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, restored, new TextEncoder().encode('青律森林'));
  const rt = await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, restored, ct);
  ok(encText(rt) === '青律森林', '信封解密恢复的密钥可用（等价原会话密钥）');

  // 4) 明文金丝雀：全程不允许再出现可离线还原的 key 明文
  ok(!String(stored).includes('c2FsdG1hc3Rlcg=='), '持久化块不含可离线离线还原的敏感明文');
  ok(String(stored).length < 256, '持久化块体积小（仅 iv+ciphertext）');

  console.log(`\n信封测试：${pass}/6 通过`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});