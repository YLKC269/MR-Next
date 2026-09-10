// core/dom.js — 极简声明式渲染助手（替代手工 DOM 拼接）。
// h(tag, props, ...children) 返回真实元素；组件即返回元素的小函数。

// 需要 px 单位、可传 number 的样式键（其它数字如 opacity/zIndex/flexGrow 不补）。
// 注意：lineHeight 故意不在列表里 —— 数字行高是无单位倍数（如 1.7 = 1.7 倍），
// 补 px 会变成 1.7px → 行高塌陷 → 日志文字全部叠在一起（视觉上像"乱码"）。
const _PX_KEYS = /^(width|height|minWidth|minHeight|maxWidth|maxHeight|top|right|bottom|left|margin|marginTop|marginRight|marginBottom|marginLeft|padding|paddingTop|paddingRight|paddingBottom|paddingLeft|gap|rowGap|columnGap|fontSize|borderRadius|flexBasis|letterSpacing|textIndent|inset|blockSize|inlineSize)$/i;

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class" || k === "className") el.className = v;
      else if (k === "style" && typeof v === "object") {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv == null) continue;
          if (typeof sv === "number" && _PX_KEYS.test(sk)) el.style[sk] = sv + "px";
          else el.style[sk] = sv;
        }
      }
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === "dataset" && typeof v === "object") {
        Object.assign(el.dataset, v);
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

export function appendChildren(el, children) {
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(
      typeof c === "string" || typeof c === "number"
        ? document.createTextNode(String(c))
        : c
    );
  }
}

export function clear(el) {
  while (el && el.firstChild) el.removeChild(el.firstChild);
}

export function mount(parent, ...children) {
  appendChildren(parent, children);
  return parent;
}
