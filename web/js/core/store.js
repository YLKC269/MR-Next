// core/store.js — 轻量响应式状态中心（~40 行，无依赖）。
// 状态变更后通知所有订阅者；组件订阅后按需重渲染自身，告别手工 DOM 手术。
//
// v1.7.8：所有写入（set/patch）与初始载入都必须过 sanitizeState —— 这是"虚拟引用
// （@image#N:xxx.png）绝不会带进出片请求"的最后一道前端防线。见 core/purify.js。

import { sanitizeState } from "./purify.js";

export function createStore(initial) {
  let state = sanitizeState(initial) || {};
  const subs = new Set();

  return {
    get: () => state,
    set(patch) {
      const raw = typeof patch === "function" ? patch(state) : patch;
      if (!raw || typeof raw !== "object") return;
      state = sanitizeState({ ...state, ...raw });
      subs.forEach((fn) => {
        try {
          fn(state);
        } catch (e) {
          console.error("[store] subscriber error", e);
        }
      });
    },
    // 局部更新某个 key（值为对象时浅合并）
    patch(key, value) {
      const cur = state[key] || {};
      this.set({ [key]: typeof value === "object" && !Array.isArray(value) ? { ...cur, ...value } : value });
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
