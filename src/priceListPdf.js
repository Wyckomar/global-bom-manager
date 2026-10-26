// Price list PDF generation: catalogue (gbom_catalog) + a price list's effective prices + product photos
// (Supabase Storage bucket "product-photos") rendered in the dealer price-list layout, printed from a new tab.
import { supabase } from "./supabaseClient";
import { buildPriceListHtml } from "./priceListTemplate";

const CURRENCY_NAMES = { CAD: "Canadian Dollars", USD: "US Dollars", EUR: "Euro" };

// Part codes that differ between the catalogue (as printed) and the BOM Manager (as keyed).
// Prefer fixing the data so these are not needed; kept here so the output is right in the meantime.
const CODE_ALIASES = {
  "4-BE800-ECO": ["4-BE800-ECO-R"],
  "P250_QD4E-HO": ["P250_QD4E-1HO"],
  "SYS250POU-2": ["SYS250-POU-2"],
  "4-UV_MS50-2_V3": ["4-UV_MS-50-2_V3"],
  "7-2": ["RL-23_436T5_(BULK_PACK_30)"], "7-8": ["RL-40_867T5_(BULK_PACK_30)"], "7-12": ["RL-84_893T5_(30)"],
  "7-4": ["RL-110_1197T5_(BULK_PACK_30)"], "7-6": ["RL-100_1197T6_(BULK_PACK_30)"], "7-11": ["RL-51_540T5_(BULK_PACK_30)"],
  "4-SV-1000-1_OR_-2": ["4-SV-1000-1", "4-SV-1000-2"], "4-SV-2000-1_OR_-2": ["4-SV-2000-1"],
  "SYS1400QD4E-1BB": ["SYS1400_QD4E-1BB10_1"], "SYS1400QD4E-2BB": ["SYS1400_QD4E-2BB10_2"],
};

export const normCode = s => String(s || "").trim().toUpperCase().replace(/[\/ ]/g, "_");

export const DEFAULT_PDF_SETTINGS = {
  company: "Wyckomar Canada Inc.",
  tagline: "UV Water Purification & Disinfection Systems",
  address: "111 Malcolm Rd., Guelph, Ontario Canada N1K 1A8   Tel (519) 822-1886   Fax (519) 763-6580",
  contact: "sales@wyckomaruv.com        www.wyckomaruv.com",
  incoterm: "EXW Guelph Ontario",
  headerRight: ["Most UV Systems are 304L SS.", "316L SS available on request.", "Errors & Omissions Excluded."],
  coverLegal: ["All Prices are Ex Works Guelph, Ontario, Canada.", "All Freight, Documentation & Insurance Additional.",
    "Wyckomar reserves the right to change product specifications and", "prices at any time without notice."],
  listPhotos: 1,
  terms: [
    { heading: "Minimum Order Size", paragraphs: [
      "Minimum order size for Dealer purchases from this price list is $250",
      "Orders of less than the minimum order size must be paid for by credit card at the time the order is placed."] },
    { heading: "Payment Terms", bullets: [
      "All orders require a Purchase Order and must be paid for prior to shipment unless credit terms have been extended to the Dealer by Wyckomar Inc.",
      "Additional fees may apply to credit card and PayPal wholesale orders.",
      "Where credit terms have been extended to Dealer, goods must be paid for within the time frame specified in the credit terms otherwise interest costs may accrue.",
      "All goods remain the property of Wyckomar Inc. until full and final payment has been received and acknowledged by Wyckomar Inc."] },
    { heading: "Product Return Policy (RMA)", paragraphs: [
      "Any item to be returned to Wyckomar Inc. requires a Return Merchandise Authorization (RMA) number that is to be plainly displayed on the outside of the parcel or parcels being returned. Goods returned without a prominently displayed RMA number may not be credited to your account. The RMA number must be obtained from Wyckomar and is available by phone, fax or e-mail. Information required to obtain an RMA number includes Serial Number, Invoice Number and information related to the product failure. Items being returned shall be no older than one year and Wyckomar must have an invoice on file for the purchase. Items said to be defective will be submitted to Wyckomar’s Quality Control Department for evaluation if determined to be a manufacturing defect, credit or replacement will be issued.",
      "If replacement parts are requested prior to our inspection of the defective product returned, the parts must be paid for as a separate and distinct order. Credits will be issued on your account for product that has been determined to be defective. While awaiting results on RMA returns, no replacement orders will be cross-shipped without being paid for.",
      "Wyckomar is not responsible for damage in shipping after product has been received by the dealer. To make a claim for shipping damage, please refer to our customer service document “How to Make a Claim” for complete instructions on managing claims for shipping damage. Shipping Damage is not a manufacturers defect, and although we will assist you in making a damage claim, Wyckomar is not responsible for any damage to products which may occur in shipping.",
      "A restocking fee may apply to items returned as a result of over-stocking, incorrect ordering, or orders cancelled by the dealer or customer.",
      "The dealer, or customer is responsible for freight charges on product returns."] },
  ],
};

/** Build an index of effective prices for a price list: normalized code -> price (list currency).
 *  priceOfBuild(key) and priceOfFG(idx) are supplied by App so the app's own costing rules are used. */
export function buildPriceIndex({ pl, data, fgItems, priceOfBuild, priceOfFG }) {
  const idx = {};
  const put = (code, price) => { if (price == null || !code) return; const n = normCode(code); if (!(n in idx)) idx[n] = price; };
  (pl.includedBuilds || []).forEach(k => {
    const b = data[k]; if (!b) return;
    const p = priceOfBuild(k);
    put(k, p); put(b.name, p);
  });
  (pl.includedFG || []).forEach(i => {
    const f = fgItems[i]; if (!f) return;
    const p = priceOfFG(i);
    put(f.sku, p); put(f.name, p);
    // "14-WFS10-1PL 10" SlimLine ..." style skus: index the leading code too
    const m = normCode(f.sku).match(/^([0-9A-Z\/_.-]+?)_/); if (m) put(m[1], p);
  });
  return idx;
}

export function resolvePrice(index, part) {
  if (!part) return null;
  const n = normCode(part);
  const cands = [n].concat(CODE_ALIASES[n] || []);
  for (const c of cands) if (c in index) return index[c];
  return null;
}

export async function fetchCatalog() {
  const { data, error } = await supabase.from("gbom_catalog").select("*").eq("active", true).order("sort_order");
  if (error) throw error;
  return data || [];
}

/** Open the rendered price list in a new tab (the tab paginates itself and offers Print / Save as PDF). */
export async function generatePriceListPdf({ pl, priceIndex, options = {} }) {
  const catalog = await fetchCatalog();
  let fromList = 0, fromCatalog = 0;
  const blocks = catalog.map(b => {
    const price_lines = (b.price_lines || []).map(l => {
      const p = resolvePrice(priceIndex, l.part);
      if (p != null) fromList++; else if (l.price_2026 != null) fromCatalog++;
      return { ...l, price: p != null ? p : (options.useCatalogFallback === false ? null : l.price_2026) };
    });
    const option_lines = (b.option_lines || []).map(o => ({ ...o, price: o.price_2026 }));
    return { ...b, price_lines, option_lines };
  });
  const base = import.meta.env.VITE_SUPABASE_URL;
  const settings = {
    ...DEFAULT_PDF_SETTINGS,
    ...(options.settings || {}),
    year: String(options.year || new Date().getFullYear()),
    editionDate: options.editionDate || new Date().toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" }),
    currencyLabel: pl.currency,
    currencyName: options.currencyName || CURRENCY_NAMES[pl.currency] || pl.currency,
    photoBase: `${base}/storage/v1/object/public/product-photos/`,
    assets: { logo: "/pricelist/logo.png", leaf: "/pricelist/leaf.png", heroLeft: "/pricelist/hero-left.png", heroRight: "/pricelist/hero-right.png", heroBottom: "/pricelist/hero-bottom.png" },
    autoPrint: !!options.autoPrint,
  };
  const html = buildPriceListHtml({ settings, blocks });
  const w = window.open("", "_blank");
  if (!w) throw new Error("Pop-up blocked: allow pop-ups for this site and try again.");
  w.document.open(); w.document.write(html); w.document.close();
  return { blocks: blocks.length, fromList, fromCatalog };
}
