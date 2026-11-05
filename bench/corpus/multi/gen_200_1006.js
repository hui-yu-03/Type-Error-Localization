const n1 = 45;
const s2 = "alpha";
const b3 = true;
const xs4 = [57, 2, 27];
const ws5 = ["tag", "node"];
const o6 = { id: 85, name: "alpha", active: true };
let acc7 = 0;
const p8 = Promise.resolve(n1);
async function g9(k) {
  const w = await p8;
  return w * k;
}
const p10 = g9(n1);
o6.name = s2;
const n11 = o6.id + n1;
function f12(x, y) {
  const t = x * y;
  return t + 34;
}
const p13 = p10.then(v => "#" + v);
function f14(x, y) {
  const t = x * y;
  return t + 58;
}
const b15 = o6.active && b3;
const p16 = p10.then(v => v * 89);
const ws17 = [s2, s2];
const p18 = p8.then(v => v * 49);
const s19 = s2.repeat(1);
const n20 = f12(n1, n1);
for (let i = 0; i < xs4.length; i++) {
  acc7 = acc7 + xs4[i];
}
const s21 = s2 + "-" + n20;
const xs22 = [n20, n11, 32];
const p23 = p18.then(v => v * 60);
const n24 = f12(n1, n20);
const p25 = p8.then(v => v * 75);
function f26(text, k) {
  const head = text.toUpperCase();
  return head.padStart(k, "*");
}
const s27 = s21.repeat(3);
const n28 = Math.max(n1, n1);
const s29 = s27 + "-" + n20;
const p30 = p10.then(v => v * 82);
const b31 = n28 > n1;
const n32 = n28 * 4 + n1;
const s33 = ws5.join(", ");
const s34 = s2 + "-" + n24;
if (b3) {
  acc7 = acc7 + n32;
} else {
  acc7 = acc7 - 61;
}
const xs35 = [n11, n24, 95];
const n36 = b31 ? n32 : n1;
const n37 = b31 ? n11 : n11;
function f38(item) {
  const label = item.name + "#" + item.id;
  return label;
}
const b39 = o6.active && b31;
const n40 = s34.length + 59;
const xs41 = [n36, n32, 69];
const o42 = { id: n20, name: s34, active: b31 };
const s43 = f38(o6);
o6.name = s34;
const s44 = f26(s2, n32);
const s45 = s43.repeat(3);
const o46 = { id: n36, name: s27, active: b31 };
const n47 = o6.id + n28;
const o48 = { id: n20, name: s43, active: b3 };
o48.name = s45;
const n49 = s45.length + 92;
const n50 = n37 * 87 + n24;
const n51 = f14(n36, n50);
const n52 = n1 - n49;
if (b3) {
  acc7 = acc7 + n50;
} else {
  acc7 = acc7 - 5;
}
xs22.push(n11);
if (b39) {
  acc7 = acc7 + n51;
} else {
  acc7 = acc7 - 63;
}
const s53 = s19.toUpperCase();
if (b3) {
  acc7 = acc7 + n52;
} else {
  acc7 = acc7 - 88;
}
const s54 = f38(o6);
const o55 = { id: n50, name: s53, active: b3 };
xs4.push(n52);
const n56 = o46.id + n47;
o46.name = s33;
const n57 = xs4.length + 98;
const n58 = f12(n50, n57);
function f59(v) {
  return v > 52;
}
const b60 = s54.startsWith("i");
const p61 = p8.then(v => "#" + v);
const b62 = s44.startsWith("a");
const ws63 = [s33, s44];
function f64(text, k) {
  const head = text.toUpperCase();
  return head.padStart(k, "*");
}
o46.id = n52 + 22;
const p65 = p18.then(v => "#" + v);
const p66 = p23.then(v => "#" + v);
o6.name = s54;
const ws67 = s44.split(",");
xs22.push(n58);
o55.id = n28 + 67;
const n68 = Math.max(n51, n50);
const n69 = n56 - n58;
const b70 = s53 === s45;
const s71 = o55.name + s54;
const b72 = n69 > n49;
const b73 = s44.startsWith("n");
const s74 = f38(o46);
const n75 = s74.length + 81;
o6.name = s54;
const b76 = xs4.includes(n58);
const p77 = p25.then(v => v * 86);
const b78 = xs41.includes(n69);
async function g79(k) {
  const w = await p30;
  return w * k;
}
const p80 = g79(n69);
if (b70) {
  acc7 = acc7 + n75;
} else {
  acc7 = acc7 - 53;
}
const p81 = p77.then(v => "#" + v);
const b82 = o6.active && b78;
const p83 = p80.then(v => v * 43);
const o84 = { id: n69, name: s71, active: b78 };
xs4.push(n58);
const b85 = xs4.includes(n68);
const s86 = f38(o55);
const s87 = f38(o6);
for (let i = 0; i < xs4.length; i++) {
  acc7 = acc7 + xs4[i];
}
const s88 = `${n69}`;
const p89 = p23.then(v => "#" + v);
const o90 = { id: n68, name: s86, active: b85 };
const p91 = p25.then(v => v * 37);
const o92 = { id: n57, name: s88, active: b82 };
const n93 = Math.max(n75, n52);
const n94 = xs4[2] * 63;
const b95 = o84.active && b85;
const s96 = f26(s86, n93);
xs41.push(n94);
const b97 = f59(n94);
const o98 = { id: n56, name: s87, active: b78 };
const s99 = s54 + "-" + n94;
const b100 = f59(n75);
const o101 = { id: n93, name: s43, active: b85 };
const p102 = Promise.resolve(n75);
for (let i = 0; i < xs4.length; i++) {
  acc7 = acc7 + xs4[i];
}
const n103 = n58 - n94;
const p104 = p102.then(v => v * 56);
const o105 = { id: n103, name: s74, active: b85 };
const n106 = xs22.length + 91;
const s107 = f64(s99, n94);
xs35.push(n75);
const f108 = (a, b) => a * b + 88;
const ws109 = [s99, s88];
const s110 = s87.padStart(71, "0");
const n111 = s107.length + 91;
const xs112 = [n111, n111, 25];
const p113 = p102.then(v => "#" + v);
const s114 = `${s110}:${n106}`;
o55.name = s107;
xs41.push(n103);
const s115 = f38(o98);
async function g116(k) {
  const w = await p77;
  return w * k;
}
const p117 = g116(n94);
const s118 = `${s45}:${n111}`;
const b119 = f59(n106);
const n120 = f12(n93, n103);
const s121 = s86 + "-" + n75;
const b122 = s53 === s118;
const xs123 = [n120, n51, 16];
const s124 = f38(o105);
