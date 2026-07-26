# 青律森林 · 脱敏系统

> 基于客户端零信任架构的数据脱敏系统  
> 在浏览器端完成敏感数据识别、脱敏与还原，服务器端无法解密原始数据

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

---

## 概述

本系统实现了一种**客户端零信任**的数据脱敏方案：

- 敏感数据在**浏览器端**被识别并替换为纯随机占位符
- 映射表使用 **AES-256-GCM** 加密后存储，密钥通过 **PBKDF2** 派生
- 服务器端仅存储加密密文和脱敏后的占位符，**无法还原原始数据**
- 全局 `fetch` 拦截器自动完成请求脱敏与响应还原，**用户无感**
- 支持**跨案件隔离**，同一原文在不同案件中映射到不同占位符

---

## 架构

```
┌──────────────────────────────────────────────┐
│                  客户端（浏览器）               │
│                                                │
│  AuthInterceptor（全局 fetch 拦截器）          │
│  POST/PUT/PATCH → 自动脱敏                    │
│  GET → 自动还原                               │
│                                                │
│  ┌─────────────┐  ┌──────────┐  ┌──────────┐  │
│  │ 脱敏引擎     │  │ 加密模块 │  │ 元数据   │  │
│  │ 敏感信息识别 │  │ AES-256- │  │ 实体角色 │  │
│  │ 纯随机占位符 │  │ GCM      │  │ 关系抽取 │  │
│  │ 跨案件隔离   │  │ PBKDF2   │  │ 语义标签 │  │
│  └─────────────┘  └──────────┘  └──────────┘  │
│                                                │
│  密钥管理：会话密钥（内存）│ 设备密钥（IndexedDB）│
│              登出即销毁    │  non-extractable   │
└──────────────────────┬───────────────────────┘
                       │ HTTPS（仅传输加密数据）
                       ▼
┌──────────────────────────────────────────────┐
│                  服务器端                     │
│          存储 AES-256-GCM 加密密文            │
│           存储纯随机占位符                     │
│           存储结构化元数据（供 AI 使用）       │
│              不存在解密密钥                    │
│            无法还原原始数据                     │
└──────────────────────────────────────────────┘
```

---

## 核心模块

### 脱敏引擎 (`desensitize-engine.ts`)

核心引擎，管理敏感信息的识别、占位符生成、映射维护和脱敏/还原操作。

**关键特性：**
- 插件式识别器接口，支持自定义敏感信息检测规则
- 纯随机占位符生成（`crypto.getRandomValues()`，8 位十六进制）
- 跨案件隔离：`MappingKey = caseId + '::' + originalText`
- 案件内一致性：同一案件内同一原文映射到同一占位符
- 导入/导出映射表（用于云端同步）

```typescript
import { DesensitizeEngine } from './desensitize-engine';

const engine = new DesensitizeEngine();

// 自定义识别器
engine.registerDetector({
  name: 'phone',
  detect(text: string) {
    const regex = /1[3-9]\d{9}/g;
    const matches: DetectorMatch[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      matches.push({
        original: match[0],
        start: match.index,
        end: match.index + match[0].length,
        type: 'MOB',
        metadata: { entityType: 'phone' },
      });
    }
    return matches;
  },
});

// 脱敏
const result = await engine.desensitize('请联系张三，电话13800138000', 'case-001');
console.log(result.text); // "请联系 a8f3d9e2，电话 b7c2e1f4"

// 还原
const restored = await engine.restore(result.text, 'case-001');
console.log(restored); // "请联系张三，电话13800138000"
```

### 随机占位符 (`random-placeholder.ts`)

使用 `crypto.getRandomValues()` 生成 8 位十六进制随机占位符。

```typescript
import { generatePlaceholder } from './random-placeholder';

const placeholder = generatePlaceholder(); // 例如 "a8f3d9e2"
```

### 加密模块 (`mapping-crypto.ts`)

AES-256-GCM 认证加密 + PBKDF2 密钥派生。

```typescript
import { deriveKeyFromPassword, encrypt, decrypt, setSessionKey, clearSessionKey } from './mapping-crypto';

// 从密码派生密钥
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await deriveKeyFromPassword('user-password', salt);

// 加密
const encrypted = await encrypt('敏感数据', key);

// 解密
const decrypted = await decrypt(encrypted, key);

// 会话密钥管理
setSessionKey(key);
// ... 使用会话密钥 ...
clearSessionKey(); // 登出时销毁
```

### 元数据系统 (`mapping-metadata.ts`)

为脱敏后的数据提供结构化语义信息，供 AI 在不接触原文的情况下完成推理分析。

```typescript
import { buildMetadata, LEGAL_ROLES, RELATION_TYPES } from './mapping-metadata';

const metadata = buildMetadata('张三', 'PER', '原告张三诉被告李四合同纠纷');
console.log(metadata.role); // "plaintiff"
```

### 云端同步 (`mapping-sync.ts`)

加密映射表的上传与拉取，支持多设备登录。

```typescript
import { onLogin, onMappingChange, onLogout } from './mapping-sync';

// 登录时：派生密钥 + 拉取云端映射 + 解密入缓存
await onLogin('user-password');

// 映射变更时：加密 + 上传云端
await onMappingChange({ caseId: 'case-001', mappings: [...] });

// 登出时：清除密钥和缓存
onLogout();
```

### 全局拦截器 (`auth-interceptor.ts`)

自动拦截全局 `fetch` 请求，对请求体脱敏、响应体还原。

```typescript
import { AuthInterceptor } from './auth-interceptor';

const interceptor = new AuthInterceptor({
  engine: desensitizeEngine,
  excludePaths: ['/api/auth/', '/api/workshop/'],
  skipFields: ['status', 'type', 'id', 'user_id'],
});

interceptor.install(); // 开始拦截
// ... 所有 fetch 请求自动脱敏/还原 ...
interceptor.uninstall(); // 停止拦截
```

---

## 安全设计

### 两级密钥体系

| 密钥类型 | 生成方式 | 存储位置 | 用途 |
|---------|---------|---------|------|
| 设备密钥 | `crypto.subtle.generateKey()` | IndexedDB（non-extractable） | 本地数据加密 |
| 会话密钥 | PBKDF2(password, salt, 100000 次迭代) | 会话内存（闭包变量） | 云端同步解密 |

### 安全防护措施

- **AES-256-GCM 认证加密**：提供机密性和完整性保护，防篡改
- **PBKDF2 100,000 次迭代**：增加暴力破解成本
- **随机盐值**：每次登录使用不同盐值，防预计算攻击
- **跨案件隔离**：同一原文在不同案件映射到不同占位符，防跨案件关联
- **密钥不可导出**：设备密钥设置为 `non-extractable`，无法通过 JS API 导出
- **登出即销毁**：会话密钥仅存于内存，登出后立即置空

### 自动清理机制

- 结案 90 天 → 归档
- 归档 180 天 → 清理
- 云端备份保留，用户访问时自动恢复

---

## 快速开始

```bash
# 安装依赖
pnpm install

# 类型检查
pnpm typecheck
```

### 基本使用

```typescript
import { DesensitizeEngine, generatePlaceholder, buildMetadata } from './src/index';

const engine = new DesensitizeEngine();

// 1. 注册自定义识别器
engine.registerDetector({
  name: 'custom',
  detect(text) {
    // 实现自定义敏感信息识别规则
    return [];
  },
});

// 2. 脱敏
const result = await engine.desensitize('原始文本', 'case-001');
console.log('脱敏后:', result.text);
console.log('映射表:', result.mappings);

// 3. 还原
const restored = await engine.restore(result.text, 'case-001');
console.log('还原后:', restored);
```

---

## 环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `SUPABASE_URL` | Supabase 项目 URL | `https://xxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase 匿名密钥 | `eyJxxx...` |

---

## 技术栈

| 技术 | 用途 |
|------|------|
| Web Crypto API | AES-256-GCM 加密 / PBKDF2 密钥派生 |
| IndexedDB | 加密映射表本地存储 |
| Supabase | 加密映射表云端同步 |
| TypeScript | 类型安全 |

---

## 场景拓展

本系统虽以浏览器端拦截器为起点，但其核心思想——**在数据产生源头即时脱敏，只传输不可逆推的占位符**——可以延伸到更广阔的安全架构中。

### 与 DLP 系统的结合

DLP（数据防泄漏）系统部署在网络的出口边界，扫描所有出站流量，发现敏感数据就拦截或告警。但 DLP 有一个天然的局限：**它看到的是明文，它必须在数据到达出口边界时才能识别和拦截**——这意味着 DLP 的生效范围仅限于出口这个单点，对于已经获准出站的数据，它无法再做进一步的保护。

如果把本系统的脱敏引擎部署到 DLP 的**下游**呢？

流量经过 DLP 的策略检查后，在真正离开内网之前，再经过一层脱敏处理：

```
内网 ──→ DLP 策略检查 ──→ 脱敏引擎 ──→ 外网
  │                       │
  │  判定是否可出站       │ 将明文替换为占位符
  │  判断敏感等级         │ 即使出站也不含敏感信息
```

这意味着什么？——DLP 依然负责它的本职：做策略判定、分级分类、行为审计。但即使 DLP 判定某份文件"可以出站"，或者某条数据绕过了 DLP 的规则，**脱敏引擎作为最后一道防线，确保离开内网的数据中没有任何明文敏感信息**。

> 这就引出一个问题：如果数据在离开内网时已经被自动脱敏，那"数据泄漏"的定义是不是需要重新审视？攻击者截获的是一堆随机字符串，这算不算泄漏？

### 部署到网关（正向代理）

如果把脱敏能力提升到网关层，会发生什么？

假设你运营一个 SaaS 平台，所有客户的流量都经过统一网关。网关持有用户派生的会话密钥（基于用户密码 PBKDF2 派生，仅存于网关内存），那么：

- **入站方向**：浏览器发出脱敏后的请求（占位符），网关**不需要解密**，直接转发到后端服务。后端永远只看到占位符。
- **出站方向**：后端返回的数据中包含占位符，网关**必须还原**才能返回给浏览器——但网关有密钥，可以实时解密映射表，完成占位符 → 原文的还原。

这意味着什么？——**后端服务甚至可以不知道自己正在处理敏感数据**。它看到的是 `a8f3d9e2` 这个名字、`b7c2e1f4` 这个电话，它不需要理解这些是什么，只需要完成业务逻辑。

> 如果业务系统本身就不接触敏感数据，那数据泄漏事件的定义是不是需要被重写？服务器被拖库，攻击者看到的是一堆无意义的随机字符串——这算不算"零数据泄漏"？

### 部署到 API 网关（反向代理）

API 网关是更常见的部署锚点。与正向代理不同，API 网关直接面对的是**第三方或异构系统**的请求。

假设一个场景：你的法律服务平台需要与法院的电子卷宗系统对接。法院系统要求传输当事人的全量信息，但你的安全合规要求**最小化数据暴露**。

在 API 网关上部署本系统的脱敏引擎：

1. **出站（你的服务 → 法院系统）**：API 网关将内部占位符还原为原文，再转发给法院。你的核心业务数据库里存的依然是占位符。
2. **入站（法院系统 → 你的服务）**：法院返回的响应中包含敏感信息，API 网关将其脱敏后存入数据库。你的开发人员维护的数据库备份中只有随机字符串。

> 这引出一个更深层的思考：当 API 网关成为"数据翻译层"——对内是占位符，对外是明文——那数据库的加密粒度是否就不再重要了？因为你数据库里本来就没有"敏感数据"可泄漏。

### 更广阔的想象

- **微服务间通信**：服务间 RPC 调用是否也可以携带脱敏后的数据？只有需要原文的服务才在网关层还原。
- **日志与审计**：系统日志中记录的是 `a8f3d9e2` 而不是"张三"，日志泄漏事件自动降级为"随机字符串泄漏"。
- **开发/测试环境**：从生产环境导出的数据天然就是脱敏的——因为生产环境存的本来就是占位符。不再需要额外开发"数据脱敏工具"。
- **AI 训练数据**：脱敏后的数据保留元数据（实体类型、角色、关系），AI 模型可以理解"原告"与"被告"之间的关系，但从不接触真实姓名。

> 如果"脱敏"不再是上线前的一个额外步骤，而是系统架构中默认的内置能力——那数据安全是不是就从"合规成本"变成了"架构红利"？

---

## 与传统方案的区别

理解本方案的最佳方式，是把它放在数据保护光谱上与其他方案对比。

### 假名化（Pseudonymization）

| 维度 | 假名化 | 本方案 |
|------|--------|--------|
| 映射方式 | 确定性替换（如 `张三 → PER_001`） | 纯随机占位符（`张三 → a8f3d9e2`） |
| 跨数据源关联 | 同一原文在不同系统中映射一致，可被关联 | 跨案件隔离，同一原文在不同案件不同映射 |
| 可逆性 | 有映射表即可还原 | 有映射表 + 会话密钥才能还原 |
| 密钥管理 | 通常密钥与服务端数据共存 | 密钥仅存于客户端内存，登出即销毁 |

**核心区别**：假名化假设"只要映射表不泄漏就安全"，但映射表与数据往往在同一权限域内。本方案将密钥与数据**物理分离**到不同信任域——服务器有数据但无密钥，客户端有密钥但无数据。

### 匿名化（Anonymization）

| 维度 | 匿名化 | 本方案 |
|------|--------|--------|
| 可逆性 | 不可逆，数据永久丢失 | 可逆，持有密钥即可还原 |
| 数据效用 | 大幅降低，统计分析可能失真 | 保留元数据，AI 分析可正常进行 |
| 合规回溯 | 无法应监管要求提供原文 | 可配合司法程序还原特定数据 |
| 适用场景 | 数据发布、公开研究 | 日常业务处理、AI 辅助分析 |

**核心区别**：匿名化是"一次性的"——数据一旦匿名就无法回头。本方案是"带着钥匙的脱敏"——日常以脱敏态运行，必要时（如应诉、审计）可在客户端还原。**匿名化解决的是"发布风险"，本方案解决的是"运行风险"。**

### 端到端加密（E2EE）

| 维度 | 端到端加密 | 本方案 |
|------|-----------|--------|
| 保护范围 | 传输过程中的数据 | 传输过程 + 静态存储 + 处理过程 |
| 服务端处理 | 服务端无法处理加密数据（需解密） | 服务端可直接处理占位符（无需解密） |
| 功能完整性 | 搜索、排序、AI 分析受限 | 全部功能可正常执行（基于元数据） |
| 密钥管理 | 通信双方各自持有 | 单一用户跨设备同步 |

**核心区别**：E2EE 确保"传输过程中没人能看到"，但数据到达服务器后必须解密才能处理——解密后的数据在服务器内存中就是明文。本方案更进一步：**服务器端处理的数据从始至终都是占位符，不在任何时间点暴露明文。** E2EE 保护的是"通道"，本方案保护的是"内容本身"。

### 方案定位光谱

```
完全明文 ───────────────────────────────────── 数据完全销毁
    │           │              │                   │
    │        假名化         端到端加密           匿名化
    │       (映射表)      (通道加密)          (不可逆)
    │
    │  ── 本方案 ──
    │  客户端脱敏 + 加密映射 + 元数据保留
    │  可逆 · 可处理 · 可审计 · 零信任
```

**本方案填补了一个长期存在的空白**：在"可逆但脆弱的假名化"和"安全但不可用的匿名化/E2EE"之间，提供了一个**既安全又可用的中间地带**。它不是要取代这些方案，而是在它们未曾覆盖的场景中——**数据在服务器端被处理时**——提供了新的选择。

---

## 许可证

[Apache License 2.0](LICENSE)

---

## 关于

本系统是 青律森林 法律服务实践管理平台的核心安全组件。

青律森林 — 一个帮助律师成长的网站 我不是工具，我是你身边的一个陪伴者——帮你理清思路、支持判断、也敢于接受你的质疑。

本项目的技术方案已于2026年7月20日在创客IP平台进行公示

---

## 关于作者

我是赵小侗律师，也是这个脱敏系统和"青律森林"网站的独立开发者。这个项目源自我在处理数据安全问题时遇到的实际需求。如果你在法律科技领域有类似需求，欢迎通过Issue或讨论区交流。