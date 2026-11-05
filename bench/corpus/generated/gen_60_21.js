const n1 = 22;
const s2 = "user";
const b3 = false;
const xs4 = [82, 37, 62];
const ws5 = ["delta", "key"];
const o6 = { id: 66, name: "gamma", active: true };
let acc7 = 0;
const o8 = { id: n1, name: s2, active: b3 };
o8.id = n1 + 30;
function f9(item) {
  const label = item.name + "#" + item.id;
  return label;
}
xs4.push(n1);
function f10(x, y) {
  const t = x * y;
  return t + 43;
}
o6.id = n1 + 3;
const n11 = n1 - n1;
const ws12 = s2.split(",");
const s13 = s2 + "-" + n1;
const n14 = xs4[2] * 97;
if (b3) {
  acc7 = acc7 + n14;
} else {
  acc7 = acc7 - 72;
}
const o15 = { id: n1, name: s13, active: b3 };
const p16 = Promise.resolve(n11);
const b17 = xs4.includes(n11);
const o18 = { id: n11, name: s2, active: b17 };
const s19 = f9(o8);
o6.name = s2;
o6.name = s19;
const b20 = o15.active && b3;
const s21 = s19.toUpperCase();
for (let i = 0; i < xs4.length; i++) {
  acc7 = acc7 + xs4[i];
}
const n22 = n1 * 85 + n1;
const b23 = s2.startsWith("t");
const n24 = s13.length + 49;
const n25 = f10(n14, n22);
const b26 = xs4.includes(n24);
async function g27(k) {
  const w = await p16;
  return w * k;
}
const p28 = g27(n25);
const s29 = s21.padStart(44, "0");
function f30(text, k) {
  const head = text.toUpperCase();
  return head.padStart(k, "*");
}
xs4.push(n22);
const s31 = `${n25}`;
const s32 = ws5.join(", ");
async function g33(k) {
  const w = await p16;
  return w * k;
}
const p34 = g33(n22);
