const n1 = 47;
const s2 = "key";
const b3 = false;
const xs4 = [37, 54, 30];
const ws5 = ["key", "alpha"];
const o6 = { id: 53, name: "item", active: true };
let acc7 = 0;
const s8 = `${s2}:${n1}`;
const b9 = s2.startsWith("t");
const s10 = `${s2}:${n1}`;
const p11 = Promise.resolve(n1);
function f12(x, y) {
  const t = x * y;
  return t + 60;
}
const ws13 = s10.split(",");
const s14 = o6.name + s10;
const o15 = { id: n1, name: s14, active: b3 };
o6.name = s2;
const n16 = s14.length + 20;
const s17 = ws5.join(", ");
const n18 = b3 ? n16 : n1;
const o19 = { id: n1, name: s10, active: b3 };
const ws20 = s17.split(",");
const n21 = xs4[1] * 5;
o6.name = s14;
const o22 = { id: n1, name: s2, active: b3 };
const p23 = Promise.resolve(n21);
const n24 = n21 - n18;
const n25 = n1 - n24;
const p26 = p11.then(v => "#" + v);
const s27 = s17 + "-" + n25;
const n28 = xs4.length + 53;
const n29 = b3 ? n24 : n25;
const n30 = xs4[1] * 65;
const b31 = s27.startsWith("b");
const s32 = `${n29}`;
const p33 = Promise.resolve(n16);
async function g34(k) {
  const w = await p23;
  return w * k;
}
const p35 = g34(n30);
const s36 = `${n21}`;
async function g37(k) {
  const w = await g34(k);
  return w + n18;
}
const p38 = g37(n28);
o6.id = n24 + 40;
const n39 = f12(n30, n29);
const n40 = n25 - n1;
const n41 = s36.length + 11;
const p42 = p35.then(v => v * 22);
const n43 = s32.length + 51;
const n44 = xs4[2] * 2;
function f45(text, k) {
  const head = text.toUpperCase();
  return head.padStart(k, "*");
}
