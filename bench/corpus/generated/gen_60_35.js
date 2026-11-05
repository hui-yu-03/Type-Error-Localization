const n1 = 71;
const s2 = "node";
const b3 = true;
const xs4 = [96, 44, 20];
const ws5 = ["item", "user"];
const o6 = { id: 33, name: "tag", active: true };
let acc7 = 0;
const n8 = o6.id + n1;
for (let i = 0; i < xs4.length; i++) {
  acc7 = acc7 + xs4[i];
}
const n9 = n8 * 64 + n1;
const n10 = b3 ? n9 : n8;
const n11 = xs4.length + 62;
const p12 = Promise.resolve(n11);
const n13 = n8 - n11;
function f14(item) {
  const label = item.name + "#" + item.id;
  return label;
}
xs4.push(n11);
const b15 = o6.active && b3;
const ws16 = s2.split(",");
const n17 = s2.length + 13;
const n18 = Math.max(n1, n13);
const s19 = f14(o6);
o6.id = n18 + 15;
if (b15) {
  acc7 = acc7 + n1;
} else {
  acc7 = acc7 - 79;
}
function f20(item) {
  const label = item.name + "#" + item.id;
  return label;
}
const o21 = { id: n10, name: s2, active: b3 };
o6.id = n11 + 67;
const s22 = f14(o6);
const o23 = { id: n13, name: s2, active: b3 };
o6.id = n10 + 88;
if (b3) {
  acc7 = acc7 + n11;
} else {
  acc7 = acc7 - 59;
}
const n24 = s2.length + 69;
const n25 = b15 ? n8 : n11;
const n26 = Math.max(n1, n24);
const ws27 = s2.split(",");
const s28 = f20(o6);
async function g29(k) {
  const w = await p12;
  return w * k;
}
const p30 = g29(n1);
const o31 = { id: n13, name: s2, active: b3 };
const p32 = Promise.resolve(n26);
const b33 = o6.active && b3;
const p34 = p32.then(v => v * 57);
