"use strict";
var Desens = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    AuthInterceptor: () => AuthInterceptor,
    DesensitizeEngine: () => DesensitizeEngine,
    LEGAL_ROLES: () => LEGAL_ROLES,
    RELATION_TYPES: () => RELATION_TYPES,
    attachMetadata: () => attachMetadata,
    buildMetadata: () => buildMetadata,
    clearSessionKey: () => clearSessionKey,
    decrypt: () => decrypt,
    deriveKeyFromPassword: () => deriveKeyFromPassword,
    deserializePayload: () => deserializePayload,
    encrypt: () => encrypt,
    extractMetadataForAI: () => extractMetadataForAI,
    generatePlaceholder: () => generatePlaceholder,
    generateSalt: () => generateSalt,
    generateTypedPlaceholder: () => generateTypedPlaceholder,
    getSessionKey: () => getSessionKey,
    inferRole: () => inferRole,
    isSessionKeyReady: () => isSessionKeyReady,
    onLogin: () => onLogin,
    onLogout: () => onLogout,
    onMappingChange: () => onMappingChange,
    restoreFromSession: () => restoreFromSession,
    restoreSessionKey: () => restoreSessionKey,
    serializePayload: () => serializePayload,
    setSessionKey: () => setSessionKey
  });

  // src/random-placeholder.ts
  var PLACEHOLDER_SEPARATOR = "_";
  var RANDOM_HEX_LENGTH = 16;
  var TYPE_PREFIX_WHITELIST = /* @__PURE__ */ new Set([
    "PER",
    "ORG",
    "MOB",
    "TEL",
    "ID",
    "EMAIL",
    "AMT",
    "DATE",
    "ADD",
    "CASE_TYPE",
    "CASE_NUMBER",
    "BANK_ACCOUNT",
    "PLATE",
    "ACCOUNT",
    "ENT"
  ]);
  var usedPlaceholders = /* @__PURE__ */ new Set();
  function randomHex() {
    const bytes = new Uint8Array(RANDOM_HEX_LENGTH / 2);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  function generateTypedPlaceholder(type) {
    const prefix = type && TYPE_PREFIX_WHITELIST.has(type) ? type : "H";
    let p;
    do {
      p = `${prefix}${PLACEHOLDER_SEPARATOR}${randomHex()}`;
    } while (usedPlaceholders.has(p));
    usedPlaceholders.add(p);
    return p;
  }
  function generatePlaceholder() {
    return randomHex();
  }

  // src/desensitize-engine.ts
  var DesensitizeEngine = class {
    /** 映射表：MappingKey -> MappingEntry */
    mappings = /* @__PURE__ */ new Map();
    /** 反向映射：占位符 -> 原文（用于还原） */
    reverseMap = /* @__PURE__ */ new Map();
    /** 待同步的新映射队列 */
    pendingSync = [];
    /** 默认跳过的字段名 */
    defaultSkipFields = /* @__PURE__ */ new Set([
      "status",
      "type",
      "deadline",
      "id",
      "user_id",
      "created_at",
      "updated_at",
      "__v",
      "version"
    ]);
    // ============================================================
    // 配置
    // ============================================================
    /**
     * 添加自定义跳过字段
     */
    addSkipField(field) {
      this.defaultSkipFields.add(field);
    }
    /**
     * 移除跳过字段
     */
    removeSkipField(field) {
      this.defaultSkipFields.delete(field);
    }
    /**
     * 设置跳过字段列表
     */
    setSkipFields(fields) {
      this.defaultSkipFields = new Set(fields);
    }
    // ============================================================
    // 核心 API
    // ============================================================
    /**
     * 对文本执行脱敏
     * @param text 原始文本
     * @param options 脱敏选项（需包含 caseId，可选 detector）
     * @returns 脱敏结果
     */
    desensitize(text, options) {
      if (!options.caseId) {
        throw new Error("caseId is required for desensitization");
      }
      const mappings = [];
      const seenPlaceholders = /* @__PURE__ */ new Set();
      let result = text;
      if (!options.detector) {
        return { text: result, mappings: [] };
      }
      const entities = options.detector.detect(text);
      const sortedEntities = [...entities].sort(
        (a, b) => b.start - a.start || b.end - a.end
      );
      const chosen = [];
      const overlapsChosen = (s, e) => chosen.some(([cs, ce]) => s < ce && e > cs);
      for (const entity of sortedEntities) {
        const s = entity.start;
        const e = entity.end;
        if (overlapsChosen(s, e)) continue;
        chosen.push([s, e]);
        const mappingKey = this.buildMappingKey(options.caseId, entity.text);
        let entry = this.mappings.get(mappingKey);
        if (!entry) {
          const placeholder = this.generateAndStoreMapping(
            entity.text,
            options.caseId,
            entity.type
          );
          entry = this.mappings.get(mappingKey);
        }
        result = result.substring(0, entity.start) + entry.placeholder + result.substring(entity.end);
        if (!seenPlaceholders.has(entry.placeholder)) {
          seenPlaceholders.add(entry.placeholder);
          mappings.push(entry);
        }
      }
      return { text: result, mappings };
    }
    /**
     * 将占位符还原为原文
     * @param text 包含占位符的文本
     * @returns 还原后的文本
     */
    restore(text) {
      if (text.length === 0 || this.reverseMap.size === 0) {
        return text;
      }
      const pattern = Array.from(this.reverseMap.keys()).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      return text.replace(
        new RegExp(pattern, "g"),
        (ph) => this.reverseMap.get(ph) ?? ph
      );
    }
    /**
     * 深度遍历并脱敏对象中的所有字符串字段
     * @param obj 要脱敏的对象
     * @param options 脱敏选项
     * @returns 脱敏后的对象副本
     */
    desensitizeObject(obj, options) {
      const skipFields = /* @__PURE__ */ new Set([
        ...this.defaultSkipFields,
        ...options.skipFields || []
      ]);
      return this.traverseAndDesensitize(obj, skipFields, options);
    }
    /**
     * 深度遍历并还原对象中的所有占位符
     * @param obj 包含占位符的对象
     * @returns 还原后的对象副本
     *
     * 注意：必须使用递归遍历而非 JSON 字符串替换（JSON.stringify → replace → parse）。
     * 若原文敏感值含双引号/反斜杠/换行，在 JSON 字符串层做正则替换会破坏结构导致
     * JSON.parse 失败或还原错位。
     */
    restoreObject(obj) {
      return this.traverseAndRestore(obj);
    }
    // ============================================================
    // 映射管理
    // ============================================================
    /**
     * 获取指定案件的所有映射
     */
    getCaseMappings(caseId) {
      const result = [];
      for (const [key, entry] of this.mappings.entries()) {
        if (key.startsWith(caseId + "::")) {
          result.push(entry);
        }
      }
      return result;
    }
    /**
     * 获取所有映射
     */
    getAllMappings() {
      return Array.from(this.mappings.values());
    }
    /**
     * 获取待同步的新映射队列
     */
    getPendingSync() {
      return [...this.pendingSync];
    }
    /**
     * 标记指定占位符的映射已同步，从待同步队列中移除
     */
    markAsSynced(placeholder) {
      this.pendingSync = this.pendingSync.filter(
        (entry) => entry.placeholder !== placeholder
      );
    }
    /**
     * 获取映射条目数量
     */
    getMappingCount() {
      return this.mappings.size;
    }
    /**
     * 清除指定案件的所有映射
     */
    clearCaseMappings(caseId) {
      for (const [key, entry] of this.mappings.entries()) {
        if (entry.caseId === caseId) {
          this.mappings.delete(key);
          this.reverseMap.delete(entry.placeholder);
        }
      }
      this.pendingSync = this.pendingSync.filter(
        (entry) => entry.caseId !== caseId
      );
    }
    /**
     * 清除所有映射
     */
    clearAllMappings() {
      this.mappings.clear();
      this.reverseMap.clear();
      this.pendingSync = [];
    }
    /**
     * 批量导入映射
     */
    importMappings(entries) {
      for (const entry of entries) {
        const key = this.buildMappingKey(entry.caseId, entry.original);
        this.mappings.set(key, entry);
        this.reverseMap.set(entry.placeholder, entry.original);
      }
    }
    /**
     * 导出所有映射
     */
    exportMappings() {
      return Array.from(this.mappings.values());
    }
    // ============================================================
    // 内部方法
    // ============================================================
    /**
     * 构建映射键（跨案件隔离的核心）
     * 格式：caseId + '::' + originalText
     */
    buildMappingKey(caseId, original) {
      return `${caseId}::${original}`;
    }
    /**
     * 生成并存储映射
     */
    generateAndStoreMapping(original, caseId, type) {
      let placeholder = generateTypedPlaceholder(type);
      while (this.reverseMap.has(placeholder)) {
        placeholder = generateTypedPlaceholder(type);
      }
      const key = this.buildMappingKey(caseId, original);
      const entry = {
        original,
        placeholder,
        caseId,
        type,
        createdAt: Date.now()
      };
      this.mappings.set(key, entry);
      this.reverseMap.set(placeholder, original);
      this.pendingSync.push(entry);
      return placeholder;
    }
    /**
     * 递归遍历并脱敏对象
     */
    traverseAndDesensitize(obj, skipFields, options) {
      if (typeof obj === "string") {
        return this.desensitize(obj, options).text;
      }
      if (Array.isArray(obj)) {
        return obj.map((item) => this.traverseAndDesensitize(item, skipFields, options));
      }
      if (obj !== null && typeof obj === "object") {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
          if (skipFields.has(key)) {
            result[key] = value;
          } else {
            result[key] = this.traverseAndDesensitize(value, skipFields, options);
          }
        }
        return result;
      }
      return obj;
    }
    /**
     * 递归遍历并还原对象（与 traverseAndDesensitize 对称）
     */
    traverseAndRestore(obj) {
      if (typeof obj === "string") {
        return this.restore(obj);
      }
      if (Array.isArray(obj)) {
        return obj.map((item) => this.traverseAndRestore(item));
      }
      if (obj !== null && typeof obj === "object") {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
          result[key] = this.traverseAndRestore(value);
        }
        return result;
      }
      return obj;
    }
  };

  // src/mapping-crypto.ts
  async function deriveKeyFromPassword(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: hexToBytes(salt),
        iterations: 1e5,
        hash: "SHA-256"
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      true,
      // extractable：为支持浏览器本地持久化（刷新恢复）而允许导出封装
      ["encrypt", "decrypt"]
    );
  }
  function generateSalt() {
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    return bytesToHex(salt);
  }
  async function encrypt(plaintext, key, salt) {
    const enc = new TextEncoder();
    const data = enc.encode(plaintext);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: 128
      },
      key,
      data
    );
    const tag = encrypted.slice(encrypted.byteLength - 16);
    const ciphertext = encrypted.slice(0, encrypted.byteLength - 16);
    return {
      salt: salt || generateSalt(),
      iv: bytesToHex(iv),
      tag: bytesToHex(new Uint8Array(tag)),
      ciphertext: arrayBufferToBase64(ciphertext)
    };
  }
  async function decrypt(payload, key) {
    const iv = hexToBytes(payload.iv);
    const tag = hexToBytes(payload.tag);
    const ciphertext = base64ToArrayBuffer(payload.ciphertext);
    const combined = new Uint8Array(ciphertext.byteLength + tag.length);
    combined.set(new Uint8Array(ciphertext), 0);
    combined.set(tag, ciphertext.byteLength);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: 128
      },
      key,
      combined
    );
    return new TextDecoder().decode(decrypted);
  }
  function serializePayload(payload) {
    return [
      payload.salt,
      payload.iv,
      payload.tag,
      payload.ciphertext
    ].join(".");
  }
  function deserializePayload(serialized) {
    const parts = serialized.split(".");
    if (parts.length !== 4) {
      throw new Error("Invalid encrypted payload format");
    }
    return {
      salt: parts[0],
      iv: parts[1],
      tag: parts[2],
      ciphertext: parts[3]
    };
  }
  var sessionKey = null;
  var SESSION_KV_ID = "olasenos_session_key";
  var keyVault = null;
  function memoryKeyVault() {
    const store = /* @__PURE__ */ new Map();
    return {
      async get(id) {
        return store.has(id) ? store.get(id) : null;
      },
      async set(id, value) {
        store.set(id, value);
      },
      async remove(id) {
        store.delete(id);
      }
    };
  }
  function createIndexedDbKeyVault() {
    const idb = globalThis.indexedDB;
    if (!idb) {
      return memoryKeyVault();
    }
    function openDb() {
      return new Promise((resolve, reject) => {
        const req = idb.open("olasenos-desens", 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains("kv")) {
            req.result.createObjectStore("kv", { keyPath: "k" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    async function idbOp(mode, act) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("kv", mode);
        const req = act(tx.objectStore("kv"));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return {
      get(id) {
        return idbOp(
          "readonly",
          (store) => store.get(id)
        ).then((r) => r ? r.v : null);
      },
      set(id, value) {
        return new Promise((resolve, reject) => {
          idbOp("readwrite", (store) => store.put({ k: id, v: value })).then(() => resolve()).catch(reject);
        });
      },
      remove(id) {
        return new Promise((resolve, reject) => {
          idbOp("readwrite", (store) => store.delete(id)).then(() => resolve()).catch(reject);
        });
      }
    };
  }
  async function getKeyVault() {
    if (!keyVault) {
      keyVault = createIndexedDbKeyVault();
    }
    return keyVault;
  }
  function bytesToBase64(bytes) {
    return arrayBufferToBase64(bytes.buffer);
  }
  function base64ToB64Bytes(b64) {
    return new Uint8Array(base64ToArrayBuffer(b64));
  }
  var DEVICE_KV_ID = "qlsl_device_key";
  async function getDeviceKey() {
    try {
      const vault = await getKeyVault();
      const existing = await vault.get(DEVICE_KV_ID);
      if (existing instanceof CryptoKey) return existing;
      const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
      await vault.set(DEVICE_KV_ID, key);
      return key;
    } catch {
      return null;
    }
  }
  async function setSessionKey(key, persist = true) {
    sessionKey = key;
    if (!persist) return;
    try {
      const raw = await crypto.subtle.exportKey("raw", key);
      const dk = await getDeviceKey();
      if (!dk) return;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dk, raw);
      await (await getKeyVault()).set(
        SESSION_KV_ID,
        bytesToBase64(iv) + ":" + bytesToBase64(new Uint8Array(ct))
      );
    } catch {
    }
  }
  function getSessionKey() {
    return sessionKey;
  }
  async function restoreSessionKey() {
    if (sessionKey) return true;
    try {
      const stored = await (await getKeyVault()).get(SESSION_KV_ID);
      if (!stored || typeof stored !== "string") return false;
      const sep = stored.indexOf(":");
      if (sep <= 0) return false;
      const iv = base64ToB64Bytes(stored.slice(0, sep)).buffer;
      const ct = base64ToB64Bytes(stored.slice(sep + 1)).buffer;
      const dk = await getDeviceKey();
      if (!dk) return false;
      const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, dk, ct);
      const key = await crypto.subtle.importKey(
        "raw",
        raw,
        { name: "AES-GCM" },
        true,
        ["encrypt", "decrypt"]
      );
      sessionKey = key;
      return true;
    } catch {
      sessionKey = null;
      return false;
    }
  }
  function isSessionKeyReady() {
    return sessionKey !== null;
  }
  async function clearSessionKey() {
    sessionKey = null;
    try {
      await (await getKeyVault()).remove(SESSION_KV_ID);
    } catch {
    }
  }
  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }
  function bytesToHex(bytes) {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // src/mapping-metadata.ts
  var LEGAL_ROLES = [
    "plaintiff",
    "defendant",
    "agent",
    "witness",
    "creditor",
    "debtor",
    "guarantor",
    "third_party",
    "executor",
    "appellant",
    "appellee",
    "victim",
    "suspect",
    "lawyer"
  ];
  var RELATION_TYPES = [
    "contract",
    "payment",
    "guarantee",
    "agency",
    "employment",
    "family",
    "property",
    "tort",
    "inheritance",
    "partnership"
  ];
  function buildMetadata(original, type, context) {
    const metadata = {
      entityType: type
    };
    if (context) {
      const role = inferRole(context, original);
      if (role) {
        metadata.role = role;
      }
    }
    return metadata;
  }
  function inferRole(context, entityName) {
    const rolePatterns = [
      { role: "plaintiff", patterns: ["\u539F\u544A", "\u8D77\u8BC9\u4EBA", "\u7533\u8BC9\u4EBA", "plaintiff"] },
      { role: "defendant", patterns: ["\u88AB\u544A", "\u88AB\u7533\u8BC9\u4EBA", "defendant"] },
      { role: "agent", patterns: ["\u4EE3\u7406\u4EBA", "\u5F8B\u5E08", "\u4EE3\u7406\u5F8B\u5E08", "agent"] },
      { role: "witness", patterns: ["\u8BC1\u4EBA", "\u89C1\u8BC1\u4EBA", "witness"] },
      { role: "creditor", patterns: ["\u503A\u6743\u4EBA", "\u51FA\u501F\u4EBA", "creditor"] },
      { role: "debtor", patterns: ["\u503A\u52A1\u4EBA", "\u501F\u6B3E\u4EBA", "debtor"] },
      { role: "guarantor", patterns: ["\u62C5\u4FDD\u4EBA", "\u4FDD\u8BC1\u4EBA", "guarantor"] },
      { role: "third_party", patterns: ["\u7B2C\u4E09\u4EBA", "\u7B2C\u4E09\u65B9", "third_party"] },
      { role: "appellant", patterns: ["\u4E0A\u8BC9\u4EBA", "appellant"] },
      { role: "appellee", patterns: ["\u88AB\u4E0A\u8BC9\u4EBA", "appellee"] },
      { role: "victim", patterns: ["\u53D7\u5BB3\u4EBA", "\u88AB\u5BB3\u4EBA", "victim"] },
      { role: "suspect", patterns: ["\u5ACC\u7591\u4EBA", "\u72AF\u7F6A\u5ACC\u7591\u4EBA", "suspect"] },
      { role: "lawyer", patterns: ["\u5F8B\u5E08", "lawyer"] }
    ];
    for (const { role, patterns } of rolePatterns) {
      for (const pattern of patterns) {
        if (context.includes(pattern) || context.includes(entityName + pattern)) {
          return role;
        }
      }
    }
    return null;
  }
  function attachMetadata(entry, metadata) {
    return {
      ...entry,
      metadata: {
        entityType: metadata.entityType,
        ...metadata.role && { role: metadata.role },
        ...metadata.semanticLabel && { semanticLabel: metadata.semanticLabel }
      }
    };
  }
  function extractMetadataForAI(entries) {
    const parts = entries.map((entry) => {
      const meta = entry.metadata || {};
      const parts2 = [`${entry.placeholder} -> [${entry.type}]`];
      if (meta.role) parts2.push(`\u89D2\u8272:${meta.role}`);
      if (meta.semanticLabel) parts2.push(`\u6807\u7B7E:${meta.semanticLabel}`);
      return parts2.join(" ");
    });
    return parts.join("\n");
  }

  // src/mapping-sync.ts
  async function onLogin(password, salt, syncAdapter) {
    const key = await deriveKeyFromPassword(password, salt);
    const encryptedPayloads = await syncAdapter.fetchMappings();
    const mappings = [];
    for (const payload of encryptedPayloads) {
      try {
        const json = await decrypt(payload, key);
        const entries = JSON.parse(json);
        mappings.push(...entries);
      } catch (error) {
        console.error("Failed to decrypt mapping:", error);
      }
    }
    await setSessionKey(key);
    return mappings;
  }
  async function onMappingChange(mappings, syncAdapter, salt) {
    const key = getSessionKey();
    if (!key) {
      throw new Error("Session key not available. Please login first.");
    }
    const json = JSON.stringify(mappings);
    const payload = await encrypt(json, key, salt);
    await syncAdapter.pushMappings(payload);
  }
  function onLogout() {
    clearSessionKey();
  }
  async function restoreFromSession(syncAdapter) {
    const restored = await restoreSessionKey();
    if (!restored) {
      return [];
    }
    const key = getSessionKey();
    if (!key) {
      return [];
    }
    try {
      const encryptedPayloads = await syncAdapter.fetchMappings();
      const mappings = [];
      for (const payload of encryptedPayloads) {
        try {
          const json = await decrypt(payload, key);
          const entries = JSON.parse(json);
          mappings.push(...entries);
        } catch (error) {
          console.error("Failed to decrypt mapping during restore:", error);
        }
      }
      return mappings;
    } catch (error) {
      console.error("Failed to fetch mappings during restore:", error);
      return [];
    }
  }

  // src/auth-interceptor.ts
  function extractCaseIdFromUrl(url) {
    try {
      const path = new URL(url, window.location.origin).pathname;
      const match = path.match(/\/api\/cases\/([^/]+)/);
      if (match && match[1]) {
        const caseId = decodeURIComponent(match[1]);
        if (caseId !== "undefined" && caseId !== "null" && caseId.length > 0) {
          return caseId;
        }
      }
    } catch {
    }
    return null;
  }
  var AuthInterceptor = class {
    engine;
    config;
    originalFetch;
    isRegistered = false;
    constructor(engine, config) {
      this.engine = engine;
      this.config = {
        apiBasePath: "/api",
        excludePaths: ["/api/auth", "/api/health"],
        ...config
      };
      this.originalFetch = window.fetch.bind(window);
    }
    /**
     * 注册拦截器（替换全局 fetch）
     */
    register() {
      if (this.isRegistered) return;
      const self = this;
      const originalFetch = this.originalFetch;
      window.fetch = async function(input, init) {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method || "GET").toUpperCase();
        if (self.shouldSkip(url)) {
          return originalFetch(input, init);
        }
        const caseId = extractCaseIdFromUrl(url);
        const effectiveOptions = {
          ...self.config.desensitizeOptions,
          ...caseId ? { caseId } : {}
        };
        if (["POST", "PUT", "PATCH"].includes(method) && init?.body) {
          try {
            const bodyObj = JSON.parse(init.body);
            const desensitized = self.engine.desensitizeObject(
              bodyObj,
              effectiveOptions
            );
            init = {
              ...init,
              body: JSON.stringify(desensitized),
              headers: {
                ...init.headers,
                "Content-Type": "application/json"
              }
            };
          } catch {
          }
        }
        const response = await originalFetch(input, init);
        if (method === "GET" && response.ok) {
          const clonedResponse = response.clone();
          const contentType = clonedResponse.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            try {
              const data = await clonedResponse.json();
              const restored = self.engine.restoreObject(data);
              return new Response(JSON.stringify(restored), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
              });
            } catch {
            }
          }
        }
        return response;
      };
      this.isRegistered = true;
    }
    /**
     * 注销拦截器（恢复原始 fetch）
     */
    unregister() {
      if (!this.isRegistered) return;
      window.fetch = this.originalFetch;
      this.isRegistered = false;
    }
    /**
     * 检查是否应该跳过脱敏
     */
    shouldSkip(url) {
      const path = new URL(url, window.location.origin).pathname;
      return this.config.excludePaths.some((exclude) => path.startsWith(exclude));
    }
  };
  return __toCommonJS(index_exports);
})();
