// Small DOM helpers.

export const $ = (id) => document.getElementById(id);

// el("div", { class: "x", text: "hi" }, child1, child2). Text is always set with textContent (safe).
export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
}

// A pixel suit icon from the sprite: "club", "spade", "heart", "diamond".
export function suit(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/img/sprite.svg#${name}`);
  svg.append(use);
  return svg;
}

// A line of feedback under a form: say("keys-msg", "Saved.", "ok") where kind is ok | err | info.
export function say(id, text, kind = "info") {
  const m = $(id);
  m.className = `msg ${kind}`;
  m.textContent = text;
}
