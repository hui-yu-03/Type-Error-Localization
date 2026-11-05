#!/usr/bin/env node
"use strict";
// Renders an HTML file to PDF with Chromium (Playwright):
//   node docs/render_pdf.js docs/report.html docs/report.pdf
const path = require("path");
const { chromium } = require("playwright");

(async () => {
  const [input, output] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("file://" + path.resolve(input), { waitUntil: "networkidle" });
  await page.pdf({
    path: output,
    format: "A4",
    printBackground: true,
    margin: { top: "20mm", bottom: "18mm", left: "18mm", right: "18mm" },
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate:
      '<div style="width:100%;font-family:Inter,sans-serif;font-size:7.5px;color:#6a7280;padding:0 18mm;display:flex;justify-content:space-between">' +
      '<span>SAT/SMT-based type error localization for a core JavaScript subset</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  });
  await browser.close();
})();
