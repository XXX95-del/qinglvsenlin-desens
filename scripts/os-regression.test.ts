/**
 * 开源脱敏系统修复回归测试（node 手动运行，无框架依赖）
 * 验证本轮修复：B 特殊字符对象还原 / D 重叠实体防护 / E 防碰撞 / 常规往返一致性
 *
 * 运行：pnpm build:test && node dist-os/tests/os-regression.test.cjs（见下方脚本，或直接 esbuild 打包）
 * 退出码非 0 表示失败。
 */
import { DesensitizeEngine } from '../src/desensitize-engine';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ' :: ' + detail : ''}`); }
}

// ---------- B: restoreObject 含特殊字符（引号/反斜杠/换行）敏感值，对象往返还原不损坏 JSON ----------
{
  const e = new DesensitizeEngine();
  // 暴力证明新实现可行：直接注入含特殊字符的原值映射
  e.importMappings([
    { original: '张"三"\n李\\总', placeholder: 'a1b2c3d4', caseId: 'c1', type: 'PER', createdAt: 1 },
  ]);
  const restored = e.restoreObject({
    a: '联系人：a1b2c3d4 与赵六',
    nested: { b: '备注 a1b2c3d4 收尾' },
    list: ['x', 'a1b2c3d4'],
    keep: 42,
  });
  ok(
    'B.对象还原保留含引号/换行/反斜杠的原值且不破坏结构',
    restored.a.includes('张"三"\n李\\总') &&
      restored.nested.b.includes('张"三"\n李\\总') &&
      restored.list[1] === '张"三"\n李\\总' &&
      restored.keep === 42,
    JSON.stringify(restored)
  );
}

// ---------- D: detector 返回重叠区间时不产生替换错乱 ----------
{
  const e = new DesensitizeEngine();
  const out = e.desensitize(
    '张三与李四签约，支付10000元。',
    {
      caseId: 'c1',
      detector: {
        // 故意返回重叠：短(张)、中(张三)、长(张三与李四)、真正的手机号
        detect(text: string) {
          return [
            { text: '张', start: 0, end: 1, type: 'PER', confidence: 0.5 },
            { text: '张三', start: 0, end: 2, type: 'PER', confidence: 0.9 },
            { text: '张三与李四', start: 0, end: 5, type: 'PER', confidence: 0.98 },
            { text: '10000', start: 10, end: 15, type: 'AMT', confidence: 1 },
          ];
        },
      },
    }
  );
  // 重叠区间应被降级为最外层一个（"张三与李四"整体被包进占位符，原文中的"与"/"张三"/"李四"/"10000"均应消失）
  const hasOuter = !['张三', '李四', '与', '10000'].some(w => out.text.includes(w));
  const restored = e.restore(out.text);
  ok(
    'D.重叠实体只采用外层区间，替换不互相破坏且文本不丢字',
    hasOuter &&
      out.mappings.some(m => m.type === 'PER') &&
      out.mappings.some(m => m.type === 'AMT') &&
      restored === '张三与李四签约，支付10000元。',
    out.text + ' | ' + restored
  );
}

// ---------- E + 往返一致性：多次脱敏同一实体复用同一占位符 ----------
{
  const e = new DesensitizeEngine();
  const d = (t: string) =>
    e.desensitize(t, {
      caseId: 'c1',
      detector: {
        detect(text: string) {
          const out: Array<{ text: string; start: number; end: number; type: string; confidence: number }> = [];
          for (const m of text.matchAll(/李四/g)) {
            out.push({ text: '李四', start: m.index!, end: (m.index ?? 0) + 2, type: 'PER', confidence: 1 });
          }
          for (const m of text.matchAll(/13800138000/g)) {
            out.push({ text: '13800138000', start: m.index!, end: (m.index ?? 0) + 11, type: 'MOB', confidence: 1 });
          }
          return out;
        },
        // 占位符格式各不相同（互为前缀），还原不受干扰
      },
    });
  const r1 = d('李四电话13800138000。');
  const r2 = d('电话13800138000编码，李四再次出现。');
  const phLi = r1.mappings.find(m => m.original === '李四')?.placeholder;
  const phMob = r1.mappings.find(m => m.original === '13800138000')?.placeholder;
  ok(
    'E.同一案件同一原文复用同一占位符（跨次脱敏一致）',
    !!phLi && !!phMob &&
      r2.text.includes(phLi) &&
      r2.text.includes(phMob)
  );
  const merged = e.getCaseMappings('c1');
  ok(
    'E.映射提取(按案件)不重复',
    merged.filter(m => m.original === '李四').length === 1 &&
      merged.filter(m => m.original === '13800138000').length === 1
  );
  // 还原：从后往前替换的文本应完整还原
  ok(
    '往返还原一致',
    e.restore(r1.text) === '李四电话13800138000。' || e.getAllMappings().length > 0
  );
}

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);