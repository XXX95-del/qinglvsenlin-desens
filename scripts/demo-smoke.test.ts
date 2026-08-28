/* 临时冒烟：直接 import 源码引擎（TS），验证 用户词Detector→脱敏→还原 闭环 */
import { DesensitizeEngine } from '../src/index';
async function main() {
  const words = ['张三', '13812345678', 'lisi@example.com'];
  const detector = {
    detect(text: string) {
      const out: {text:string;start:number;end:number;type:string;confidence:number}[] = [];
      for (const w of words) {
        let i = text.indexOf(w);
        while (i !== -1) {
          out.push({ text: w, start: i, end: i + w.length, type: 'CUSTOM', confidence: 0.95 });
          i = text.indexOf(w, i + w.length);
        }
      }
      return out;
    },
  };
  const engine = new DesensitizeEngine();
  const src = '原告张三向13812345678转账，邮箱lisi@example.com。';
  const masked = engine.desensitize(src, { caseId: 'demo-case', detector });
  console.log('脱敏:', masked.text);
  const restored = engine.restore(masked.text);
  console.log('还原一致:', restored === src ? 'PASS' : `FAIL → ${restored}`);
}
main();
