import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { supabase } from './supabaseClient';

// ─── GLOBALS ──────────────────────────────────────────────────────────────────
const fmt = (n, dec = 2) => n == null ? "—" : Number(n).toFixed(dec);
const fmtCurr = (n, sym = "CAD $") => n == null ? "—" : `${sym}${Number(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TABS = ["Builds", "Parts Library", "Finished Goods", "Pricing Analysis", "Price Lists"];
const CURRENCY_SYMBOLS = { CAD: "CAD $", EUR: "€", USD: "US $", GBP: "£", AUD: "A$" };

const DEFAULT_PRICE_LISTS = [
  { id: "domestic_cad", name: "Domestic Canada", currency: "CAD", fxRate: 1.0, fxBase: "CAD", shippingDefault: 0, shippingAbsorbed: false, discountPct: 0, notes: "Standard Canadian pricing", systemOverrides: {}, includedBuilds: [], includedFG: [] },
  { id: "eu_distributor", name: "EU / Snijder", currency: "EUR", fxRate: 0.68, fxBase: "CAD", shippingDefault: 95, shippingAbsorbed: false, discountPct: 0, notes: "EUR pricing for European distributors", systemOverrides: {}, includedBuilds: [], includedFG: [] },
  { id: "usd_global", name: "USD Global", currency: "USD", fxRate: 0.74, fxBase: "CAD", shippingDefault: 60, shippingAbsorbed: true, discountPct: 0, notes: "USD pricing for North American export", systemOverrides: {}, includedBuilds: [], includedFG: [] }
];

// ─── COSTING ──────────────────────────────────────────────────────────────────
function calcBuildCost(build, gs) {
  const parts = build.parts || [];
  const cadToUsdRate = gs.cadToUsd ?? 0.74;
  const cadToEurRate = gs.cadToEur ?? 0.68;
  const toCAD = (price, currency) => {
    if (!currency || currency === "CAD") return price;
    if (currency === "USD") return price / cadToUsdRate;
    if (currency === "EUR") return price / cadToEurRate;
    if (currency === "GBP") return price / (gs.cadToGbp ?? 0.54);
    return price;
  };
  const matCost = parts.reduce((s, p) => s + toCAD(p.price_ea || 0, p.currency) * (p.qty || 1), 0);
  const s = build.summary || {};
  const laborRate = s.labor_rate ?? gs.laborRate ?? 25;
  const ohRate = s.oh_rate ?? gs.ohRate ?? 1.85;
  const laborMins = s.labor_mins ?? gs.defaultLaborMins ?? 30;
  const laborCost = (laborRate / 60) * laborMins;
  const ohCost = laborCost * ohRate;
  const factoryCost = matCost + laborCost + ohCost;
  const markup = s.markup ?? gs.markup ?? 0.63;
  const minSellCAD = factoryCost / (1 - markup);
  const cadToEur = gs.cadToEur ?? 0.68;
  const cadToUsd = gs.cadToUsd ?? 0.74;
  const actualCAD = s.actual_price_cad;
  const margin = actualCAD != null ? actualCAD - factoryCost : null;
  const gm = actualCAD != null && actualCAD > 0 ? margin / actualCAD : null;
  const zeroCostCount = parts.filter(p => (p.price_ea || 0) === 0).length;
  const nestedCount = parts.filter(p => p.is_build).length;
  return { matCost, laborCost, ohCost, factoryCost, markup, minSellCAD, minSellEUR: minSellCAD * cadToEur, minSellUSD: minSellCAD * cadToUsd, actualCAD, margin, gm, cadToEur, cadToUsd, zeroCostCount, nestedCount, actualEUR: actualCAD != null ? actualCAD * cadToEur : null };
}

function calcFGCost(item, gs) {
  const laborRate = item.labor_rate ?? gs.laborRate ?? 25;
  const ohRate = item.oh_rate ?? gs.ohRate ?? 1.85;
  const laborMins = item.labor_mins ?? gs.defaultLaborMins ?? 15;
  const markup = item.markup ?? gs.markup ?? 0.63;
  const cadToEur = gs.cadToEur ?? 0.68;
  const laborCost = (laborRate / 60) * laborMins;
  const ohCost = laborCost * ohRate;
  const factoryCost = (item.cost_cad || 0) + laborCost + ohCost;
  const minSellCAD = factoryCost / (1 - markup);
  const minSellEUR = minSellCAD * cadToEur;
  const actualCAD = item.sell_price_cad ?? null;
  const margin = actualCAD != null ? actualCAD - factoryCost : null;
  const gm = actualCAD != null && actualCAD > 0 ? margin / actualCAD : null;
  return { laborCost, ohCost, factoryCost, minSellCAD, minSellEUR, actualCAD, margin, gm };
}

function calcPLBuildEntry(sysKey, system, pl, gs) {
  const c = calcBuildCost(system, gs);
  const fxRate = pl.fxRate ?? 1;
  const sym = CURRENCY_SYMBOLS[pl.currency] || pl.currency + " ";
  const discountPct = (pl.discountPct ?? 0) / 100;
  const shippingNative = pl.shippingDefault ?? 0;
  const shippingAbsorbed = pl.shippingAbsorbed ?? false;
  const override = pl.systemOverrides?.[sysKey] ?? {};
  const overrideSellPrice = override.sellPrice ?? null;
  const overrideShipping = override.shipping ?? null;
  const effectiveShipping = overrideShipping ?? shippingNative;
  const minSellNative = c.minSellCAD * fxRate;
  const baseSellNative = overrideSellPrice ?? minSellNative;
  const afterDiscount = baseSellNative * (1 - discountPct);
  const totalSellNative = afterDiscount + (shippingAbsorbed ? 0 : effectiveShipping);
  const revenueCAD = totalSellNative / fxRate;
  const realMarginCAD = revenueCAD - c.factoryCost;
  const realGM = revenueCAD > 0 ? realMarginCAD / revenueCAD : null;
  return { ...c, fxRate, sym, discountPct, effectiveShipping, shippingAbsorbed, revenueCAD, realMarginCAD, realGM, minSellNative, baseSellNative, totalSellNative, hasOverride: !!overrideSellPrice };
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const THEME = {
  bg: "#0a1628",
  surface: "#0f2035",
  surfaceLight: "#132d4a",
  border: "#1a3a5c",
  borderLight: "#245080",
  accent: "#00b4d8",
  accentDark: "#0077b6",
  accentGlow: "rgba(0,180,216,0.15)",
  green: "#00c9a7",
  greenDark: "#00a389",
  red: "#ff6b6b",
  orange: "#ffa726",
  purple: "#b388ff",
  text: "#e8f4f8",
  textMuted: "#7eb8ce",
  textDim: "#4a7a8c",
  gold: "#ffd54f",
};

// ─── Collapsible Category Section ──────────────────────────────────────────
function PLCategorySection({ title, count, defaultOpen, children }) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div style={{ marginBottom: 4 }}>
      <div onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0", cursor: "pointer", userSelect: "none" }}>
        <span style={{ color: THEME.accent, fontSize: 12, fontWeight: 700, width: 16 }}>{open ? "▼" : "►"}</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: THEME.text }}>{title}</span>
        <span style={{ fontSize: 12, color: THEME.textDim, background: THEME.accentGlow, padding: "1px 8px", borderRadius: 10 }}>{count}</span>
      </div>
      {open && children}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App({ session }) {
  const [data, setData] = useState({});
  const [priceLists, setPriceLists] = useState(() => JSON.parse(JSON.stringify(DEFAULT_PRICE_LISTS)));
  const [fgItems, setFgItems] = useState([]);
  const [editingFG, setEditingFG] = useState(null);
  const [activeTab, setActiveTab] = useState(0);
  const [selectedBuild, setSelectedBuild] = useState(null);
  const [gs, setGs] = useState({ laborRate: 25, ohRate: 1.85, markup: 0.63, cadToEur: 0.68, cadToUsd: 0.74, defaultLaborMins: 30 });
  const [editingPart, setEditingPart] = useState(null);
  const [editingSummary, setEditingSummary] = useState(false);
  const [search, setSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [editingPriceList, setEditingPriceList] = useState(null);
  const [selectedPriceList, setSelectedPriceList] = useState(null);
  const [editingPLOverride, setEditingPLOverride] = useState(null);
  const [managingPLItems, setManagingPLItems] = useState(null);
  const [editingLibPart, setEditingLibPart] = useState(null);
  const [deletingLibPart, setDeletingLibPart] = useState(null);
  const [dbLoading, setDbLoading] = useState(true);
  const [expandedNested, setExpandedNested] = useState({});
  const [filterZeroCost, setFilterZeroCost] = useState(false);
  const [filterNested, setFilterNested] = useState(false);
  const [plSearch, setPlSearch] = useState("");
  const [testDiscount, setTestDiscount] = useState(0);
  const [showMarginAnalysis, setShowMarginAnalysis] = useState(false);
  const [showPartsPicker, setShowPartsPicker] = useState(false);
  const [partsPickerSearch, setPartsPickerSearch] = useState("");
  const [editBuildMeta, setEditBuildMeta] = useState(null);
  const [newLibPart, setNewLibPart] = useState(null);
  const initialLoadDone = useRef(false);

  const showToast = (msg, type = "success") => { setToast({ msg, type }); setTimeout(() => setToast(null), 2800); };
  const userId = session?.user?.id;

  const persist = useCallback((nd) => {
    setData(nd);
    if (userId) supabase.from('gbom_builds').upsert({ user_id: userId, data: nd, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }).then();
  }, [userId]);
  const persistPL = useCallback((pl) => {
    setPriceLists(pl);
    if (userId) supabase.from('gbom_price_lists').upsert({ user_id: userId, data: pl, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }).then();
  }, [userId]);
  const persistFG = useCallback((items) => {
    setFgItems(items);
    if (userId) supabase.from('gbom_fg_items').upsert({ user_id: userId, data: items, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }).then();
  }, [userId]);

  useEffect(() => {
    if (!userId || initialLoadDone.current) return;
    initialLoadDone.current = true;
    async function loadFromDB() {
      try {
        const [bomRes, plRes, fgRes] = await Promise.all([
          supabase.from('gbom_builds').select('data').eq('user_id', userId).maybeSingle(),
          supabase.from('gbom_price_lists').select('data').eq('user_id', userId).maybeSingle(),
          supabase.from('gbom_fg_items').select('data').eq('user_id', userId).maybeSingle(),
        ]);
        if (bomRes.data?.data && Object.keys(bomRes.data.data).length > 0) {
          setData(bomRes.data.data);
          setSelectedBuild(Object.keys(bomRes.data.data)[0]);
        } else {
          try {
            const resp = await fetch('/seed_data.json');
            const seed = await resp.json();
            setData(seed);
            setSelectedBuild(Object.keys(seed)[0]);
            supabase.from('gbom_builds').upsert({ user_id: userId, data: seed }, { onConflict: 'user_id' }).then(res => {
              if (res.error) console.warn('Seed save deferred:', res.error.message);
            });
          } catch (e) { console.error('Failed to load seed:', e); setData({}); }
        }
        if (plRes.data?.data) setPriceLists(plRes.data.data);
        else { const s = JSON.parse(JSON.stringify(DEFAULT_PRICE_LISTS)); setPriceLists(s); supabase.from('gbom_price_lists').upsert({ user_id: userId, data: s }, { onConflict: 'user_id' }); }
        if (fgRes.data?.data) setFgItems(fgRes.data.data);
      } catch (err) { console.error('DB load failed:', err); }
      finally { setDbLoading(false); }
    }
    loadFromDB();
  }, [userId]);

  const handleSignOut = async () => { await supabase.auth.signOut(); };

  // ─── Data Ops ───
  const saveFGItem = (idx, item) => { const next = [...fgItems]; if (idx === -1) next.push({ ...item, id: Date.now() }); else next[idx] = { ...item }; persistFG(next); setEditingFG(null); showToast(idx === -1 ? "Item added" : "Item saved"); };
  const deleteFGItem = (idx) => { persistFG(fgItems.filter((_, i) => i !== idx)); setConfirmDelete(null); showToast("Item deleted", "warn"); };

  const buildKeys = useMemo(() => {
    let keys = Object.keys(data);
    if (search) { const s = search.toLowerCase(); keys = keys.filter(k => { const b = data[k]; return b.name?.toLowerCase().includes(s) || b.description?.toLowerCase().includes(s) || (b.parts || []).some(p => p.part_number?.toLowerCase().includes(s) || p.description?.toLowerCase().includes(s)); }); }
    if (filterZeroCost) keys = keys.filter(k => (data[k].parts || []).some(p => (p.price_ea || 0) === 0));
    if (filterNested) keys = keys.filter(k => (data[k].parts || []).some(p => p.is_build));
    return keys;
  }, [data, search, filterZeroCost, filterNested]);

  const currentBuild = data[selectedBuild];
  const calc = useMemo(() => currentBuild ? calcBuildCost(currentBuild, gs) : null, [currentBuild, gs]);

  const savePart = (bk, idx, updated) => { const nd = JSON.parse(JSON.stringify(data)); if (idx === -1) nd[bk].parts.push(updated); else nd[bk].parts[idx] = updated; persist(nd); setEditingPart(null); showToast("Part saved"); };
  const deletePart = (bk, idx) => { const nd = JSON.parse(JSON.stringify(data)); nd[bk].parts.splice(idx, 1); persist(nd); setConfirmDelete(null); showToast("Part removed", "warn"); };
  const saveSummary = (bk, summ) => { const nd = JSON.parse(JSON.stringify(data)); nd[bk].summary = { ...nd[bk].summary, ...summ }; persist(nd); setEditingSummary(false); showToast("Pricing config saved"); };
  const addBuild = () => { const id = `BUILD_${Date.now()}`; const nd = JSON.parse(JSON.stringify(data)); nd[id] = { name: "New Build", description: "", parts: [], summary: { markup: 0.63, oh_rate: 1.85 }, currency: "CAD" }; persist(nd); setSelectedBuild(id); showToast("New build created"); };
  const deleteBuild = (k) => { const nd = JSON.parse(JSON.stringify(data)); delete nd[k]; persist(nd); setSelectedBuild(Object.keys(nd)[0] || null); setConfirmDelete(null); showToast("Build deleted", "warn"); };
  const duplicateBuild = (k) => { const id = `COPY_${Date.now()}`; const nd = JSON.parse(JSON.stringify(data)); nd[id] = { ...JSON.parse(JSON.stringify(nd[k])), name: `${nd[k].name} (Copy)` }; persist(nd); setSelectedBuild(id); setEditBuildMeta({ key: id, name: nd[id].name, description: nd[id].description || "" }); showToast("Duplicated — edit the name below"); };

  const saveBuildMeta = () => {
    if (!editBuildMeta) return;
    const nd = JSON.parse(JSON.stringify(data));
    nd[editBuildMeta.key].name = editBuildMeta.name;
    nd[editBuildMeta.key].description = editBuildMeta.description;
    if (editBuildMeta.category !== undefined) nd[editBuildMeta.key].category = editBuildMeta.category;
    persist(nd); setEditBuildMeta(null); showToast("Build updated");
  };

  const addPartFromLibrary = (libPart) => {
    if (!selectedBuild) return;
    const nd = JSON.parse(JSON.stringify(data));
    nd[selectedBuild].parts.push({ part_number: libPart.part_number, description: libPart.description, qty: 1, unit: libPart.unit || "Each", price_ea: libPart.price_ea || 0, currency: libPart.currency || "CAD", vendor: libPart.vendor || "", retail_pn: libPart.retail_pn || "", mfg_pn: libPart.mfg_pn || "", is_build: libPart.is_build || false });
    persist(nd); showToast(`Added "${libPart.part_number}"`);
  };

  const createNewLibPart = (part, addToFG, sellPrice, category) => {
    // Add to current build if one is selected
    if (selectedBuild) {
      const nd = JSON.parse(JSON.stringify(data));
      nd[selectedBuild].parts.push({ ...part, is_build: false });
      persist(nd);
    }
    // Add to FG if requested
    if (addToFG) {
      const exists = fgItems.some(fg => fg.sku === part.part_number);
      if (!exists) {
        persistFG([...fgItems, { id: Date.now(), name: part.description || part.part_number, sku: part.part_number, category: category || "", vendor: part.vendor || "", cost_cad: part.price_ea || 0, labor_mins: 15, sell_price_cad: sellPrice || 0, notes: "Created from Parts Library", retail_pn: part.retail_pn || "", mfg_pn: part.mfg_pn || "" }]);
      }
    }
    setNewLibPart(null); showToast("Part created");
  };

  const allParts = useMemo(() => {
    const map = {};
    Object.entries(data).forEach(([sk, b]) => { (b.parts || []).forEach(p => { const pn = p.part_number?.trim(); if (!pn) return; if (!map[pn]) map[pn] = { ...p, systems: [sk], totalQty: p.qty || 1 }; else { map[pn].systems.push(sk); map[pn].totalQty += (p.qty || 1); } }); });
    return Object.values(map).sort((a, b) => a.part_number.localeCompare(b.part_number));
  }, [data]);

  const saveLibPart = (oldPN, updated) => {
    const nd = JSON.parse(JSON.stringify(data)); let count = 0;
    Object.values(nd).forEach(b => { (b.parts || []).forEach(p => { if (p.part_number?.trim() === oldPN) { Object.assign(p, { part_number: updated.part_number, description: updated.description, vendor: updated.vendor, price_ea: updated.price_ea, currency: updated.currency, retail_pn: updated.retail_pn, mfg_pn: updated.mfg_pn }); count++; } }); });
    persist(nd); setEditingLibPart(null); showToast(`Saved across ${count} line(s)`);
  };
  const deleteLibPart = (pn) => { const nd = JSON.parse(JSON.stringify(data)); Object.values(nd).forEach(b => { b.parts = (b.parts || []).filter(p => p.part_number?.trim() !== pn); }); persist(nd); setDeletingLibPart(null); showToast("Deleted from all builds", "warn"); };

  const promoteToFG = (part, sellPrice, category) => {
    const existingIdx = fgItems.findIndex(fg => fg.sku === part.part_number);
    if (existingIdx >= 0) { showToast("Already exists as Finished Good", "warn"); return; }
    const newFG = { id: Date.now(), name: part.description || part.part_number, sku: part.part_number, category: category || "", vendor: part.vendor || "", cost_cad: part.price_ea || 0, labor_mins: 15, sell_price_cad: sellPrice || 0, notes: `Promoted from Parts Library`, retail_pn: part.retail_pn || "", mfg_pn: part.mfg_pn || "" };
    persistFG([...fgItems, newFG]);
    showToast(`"${part.part_number}" added to Finished Goods`);
  };

  const downloadBackup = () => { const snap = { data, priceLists, fgItems, ts: new Date().toISOString() }; const blob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `global_bom_backup_${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(url); showToast("Backup downloaded"); };
  const restoreBackup = (e) => { const file = e.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = (ev) => { try { const snap = JSON.parse(ev.target.result); if (!snap.data) throw new Error("Invalid"); persist(snap.data); if (snap.priceLists) persistPL(snap.priceLists); if (snap.fgItems) persistFG(snap.fgItems); setSelectedBuild(Object.keys(snap.data)[0]); showToast(`Restored from ${snap.ts?.slice(0,10) || "file"}`); } catch { showToast("Invalid backup file", "warn"); } }; reader.readAsText(file); e.target.value = ""; };

  const toggleNested = (pn) => setExpandedNested(prev => ({ ...prev, [pn]: !prev[pn] }));
  const findBuildByName = (name) => Object.entries(data).find(([k, b]) => b.name === name);

  // ─── Price List Helpers ───
  const toggleBuildInPL = (plIdx, buildKey) => {
    const next = JSON.parse(JSON.stringify(priceLists));
    const pl = next[plIdx];
    if (!pl.includedBuilds) pl.includedBuilds = [];
    const idx = pl.includedBuilds.indexOf(buildKey);
    if (idx >= 0) pl.includedBuilds.splice(idx, 1);
    else pl.includedBuilds.push(buildKey);
    persistPL(next);
  };
  const toggleFGInPL = (plIdx, fgIdx) => {
    const next = JSON.parse(JSON.stringify(priceLists));
    const pl = next[plIdx];
    if (!pl.includedFG) pl.includedFG = [];
    const idx = pl.includedFG.indexOf(fgIdx);
    if (idx >= 0) pl.includedFG.splice(idx, 1);
    else pl.includedFG.push(fgIdx);
    persistPL(next);
  };
  const savePLOverride = (plIdx, buildKey, sellPrice) => {
    const next = JSON.parse(JSON.stringify(priceLists));
    if (!next[plIdx].systemOverrides) next[plIdx].systemOverrides = {};
    if (sellPrice === null || sellPrice === "") delete next[plIdx].systemOverrides[buildKey];
    else next[plIdx].systemOverrides[buildKey] = { sellPrice: parseFloat(sellPrice) };
    persistPL(next); setEditingPLOverride(null); showToast("Override saved");
  };

  const duplicatePriceList = (idx, newName, newCurrency) => {
    const src = priceLists[idx];
    const oldFx = src.fxRate || 1;
    const newFxRates = { CAD: 1.0, USD: gs.cadToUsd || 0.74, EUR: gs.cadToEur || 0.68, GBP: gs.cadToGbp || 0.54, AUD: gs.cadToAud || 0.91 };
    const newFx = newFxRates[newCurrency] || 1;
    const conversionFactor = newFx / oldFx;
    const newOverrides = {};
    Object.entries(src.systemOverrides || {}).forEach(([k, v]) => {
      if (v.sellPrice) newOverrides[k] = { sellPrice: Math.round(v.sellPrice * conversionFactor * 100) / 100 };
    });
    const newPL = { ...JSON.parse(JSON.stringify(src)), id: `pl_${Date.now()}`, name: newName || `${src.name} (Copy)`, currency: newCurrency || src.currency, fxRate: newFx, systemOverrides: newOverrides };
    persistPL([...priceLists, newPL]);
    showToast(`Created "${newPL.name}"`);
  };

  const [duplicatingPL, setDuplicatingPL] = useState(null);

  const activePLIndex = priceLists.findIndex(pl => pl.id === selectedPriceList);
  const activePL = activePLIndex >= 0 ? priceLists[activePLIndex] : null;

  if (dbLoading) return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", background: THEME.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
      <img src="/logo.png" alt="Wyckomar" style={{ height: 60, opacity: 0.8 }} />
      <div style={{ color: THEME.textMuted, fontSize: 16 }}>Loading your data...</div>
    </div>
  );

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", background: THEME.bg, minHeight: "100vh", color: THEME.text }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: ${THEME.bg}; }
        ::-webkit-scrollbar-thumb { background: ${THEME.border}; border-radius: 3px; }
        input, select, textarea { outline: none; }
        input:focus, select:focus, textarea:focus { border-color: ${THEME.accent} !important; box-shadow: 0 0 0 2px ${THEME.accentGlow}; }
        .row-hover:hover { background: ${THEME.accentGlow} !important; }
        .btn { cursor: pointer; border: none; border-radius: 6px; font-family: inherit; font-size: 13px; font-weight: 500; transition: all 0.2s; padding: 7px 14px; }
        .btn-primary { background: linear-gradient(135deg, ${THEME.accentDark}, ${THEME.accent}); color: white; }
        .btn-primary:hover { background: linear-gradient(135deg, ${THEME.accent}, #48cae4); box-shadow: 0 2px 12px ${THEME.accentGlow}; }
        .btn-green { background: linear-gradient(135deg, ${THEME.greenDark}, ${THEME.green}); color: white; }
        .btn-green:hover { box-shadow: 0 2px 12px rgba(0,201,167,0.3); }
        .btn-danger { background: ${THEME.red}; color: white; }
        .btn-danger:hover { background: #ff8a8a; }
        .btn-ghost { background: transparent; color: ${THEME.textMuted}; border: 1px solid ${THEME.border}; }
        .btn-ghost:hover { color: ${THEME.text}; border-color: ${THEME.accent}; background: ${THEME.accentGlow}; }
        .btn-sm { padding: 4px 10px; font-size: 12px; }
        .input-field { width: 100%; padding: 7px 10px; background: ${THEME.bg}; border: 1px solid ${THEME.border}; border-radius: 6px; color: ${THEME.text}; font-size: 13px; font-family: inherit; transition: all 0.2s; }
        .zero-cost { background: rgba(255,107,107,0.06) !important; }
        .nested-badge { display: inline-block; background: rgba(179,136,255,0.15); color: ${THEME.purple}; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; cursor: pointer; margin-left: 6px; }
        .nested-badge:hover { background: rgba(179,136,255,0.3); }
        .card { background: ${THEME.surface}; border: 1px solid ${THEME.border}; border-radius: 10px; }
        .card:hover { border-color: ${THEME.borderLight}; }
        .stat-card { background: linear-gradient(135deg, ${THEME.surface}, ${THEME.surfaceLight}); border: 1px solid ${THEME.border}; border-radius: 10px; padding: 14px 18px; }
        .table-wrap { background: ${THEME.surface}; border: 1px solid ${THEME.border}; border-radius: 10px; overflow: hidden; }
      `}</style>

      {toast && <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, padding: "12px 24px", borderRadius: 10, fontSize: 13, fontWeight: 600, color: "white", background: toast.type === "warn" ? `linear-gradient(135deg, ${THEME.red}, #ff8a8a)` : `linear-gradient(135deg, ${THEME.greenDark}, ${THEME.green})`, boxShadow: "0 4px 24px rgba(0,0,0,0.4)" }}>{toast.msg}</div>}

      {/* ═══ HEADER ═══ */}
      <div style={{ background: `linear-gradient(135deg, ${THEME.surface} 0%, ${THEME.surfaceLight} 100%)`, borderBottom: `1px solid ${THEME.border}`, padding: "10px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img src="/logo.png" alt="Wyckomar" style={{ height: 38 }} />
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: THEME.text, lineHeight: 1.2 }}>Global BOM Manager</div>
            <div style={{ fontSize: 10, color: THEME.textDim, letterSpacing: 1, textTransform: "uppercase" }}>UV Purification Systems</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
          {TABS.map((t, i) => (
            <button key={t} className={`btn btn-sm ${activeTab === i ? "btn-primary" : "btn-ghost"}`} onClick={() => { setActiveTab(i); setSelectedPriceList(null); }}>{t}</button>
          ))}
          <div style={{ width: 1, height: 20, background: THEME.border, margin: "0 4px" }} />
          <button className="btn btn-ghost btn-sm" onClick={() => setShowSettings(!showSettings)}>⚙</button>
          <button className="btn btn-ghost btn-sm" onClick={downloadBackup} style={{ color: THEME.green }}>⬇</button>
          <label className="btn btn-ghost btn-sm" style={{ color: THEME.accent, cursor: "pointer" }}>⬆ <input type="file" accept=".json" style={{ display: "none" }} onChange={restoreBackup} /></label>
          <button className="btn btn-ghost btn-sm" onClick={handleSignOut} style={{ color: THEME.red }}>⏻</button>
        </div>
      </div>

      {showSettings && (
        <div style={{ background: THEME.bg, borderBottom: `1px solid ${THEME.border}`, padding: "16px 24px" }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12, color: THEME.accent }}>Global Defaults</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12 }}>
            {[["Labor Rate ($/hr)", "laborRate"], ["O/H Multiplier", "ohRate"], ["Default Markup", "markup"], ["CAD → EUR", "cadToEur"], ["CAD → USD", "cadToUsd"], ["Labor (min)", "defaultLaborMins"]].map(([l, k]) => (
              <div key={k}><div style={{ fontSize: 11, color: THEME.textDim, marginBottom: 4 }}>{l}</div><input className="input-field" type="number" step="0.01" value={gs[k]} onChange={e => setGs(s => ({ ...s, [k]: parseFloat(e.target.value) || 0 }))} /></div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ TAB 0: BUILDS ═══ */}
      {activeTab === 0 && (
        <div style={{ display: "flex", height: "calc(100vh - 62px)" }}>
          <div style={{ width: 260, borderRight: `1px solid ${THEME.border}`, background: THEME.bg, overflowY: "auto", padding: "12px 0" }}>
            <div style={{ padding: "0 12px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: THEME.textDim, fontWeight: 600 }}>BUILDS ({buildKeys.length})</span>
              <button className="btn btn-primary btn-sm" onClick={addBuild}>+ New</button>
            </div>
            <div style={{ padding: "0 12px", marginBottom: 8 }}>
              <input className="input-field" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} style={{ fontSize: 12, padding: "5px 8px" }} />
            </div>
            <div style={{ padding: "0 12px", marginBottom: 8, display: "flex", gap: 4 }}>
              <button className={`btn btn-sm ${filterZeroCost ? "btn-danger" : "btn-ghost"}`} onClick={() => setFilterZeroCost(!filterZeroCost)} style={{ fontSize: 10, padding: "2px 6px" }}>$0</button>
              <button className={`btn btn-sm ${filterNested ? "" : "btn-ghost"}`} onClick={() => setFilterNested(!filterNested)} style={{ fontSize: 10, padding: "2px 6px", ...(filterNested ? { background: THEME.purple, color: "white", border: "none" } : {}) }}>Nested</button>
            </div>
            {buildKeys.map(k => { const b = data[k]; const c = calcBuildCost(b, gs); return (
              <div key={k} onClick={() => setSelectedBuild(k)} style={{ padding: "8px 12px", cursor: "pointer", borderLeft: selectedBuild === k ? `3px solid ${THEME.accent}` : "3px solid transparent", background: selectedBuild === k ? THEME.accentGlow : "transparent", transition: "all 0.15s" }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: selectedBuild === k ? THEME.text : THEME.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.name}{c.nestedCount > 0 && <span style={{ color: THEME.purple, fontSize: 10, marginLeft: 4 }}>◆</span>}</div>
                <div style={{ fontSize: 11, color: THEME.textDim, display: "flex", gap: 8 }}><span>FC {fmtCurr(c.factoryCost)}</span>{c.zeroCostCount > 0 && <span style={{ color: THEME.red }}>{c.zeroCostCount} @ $0</span>}</div>
              </div>
            ); })}
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
            {currentBuild ? (<>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{currentBuild.name}{currentBuild.name?.startsWith('*DNU') && <span style={{ fontSize: 12, color: THEME.orange, marginLeft: 8, background: "rgba(255,167,38,0.12)", padding: "2px 8px", borderRadius: 4 }}>DO NOT USE</span>}<button className="btn btn-ghost btn-sm" style={{ marginLeft: 8, padding: "2px 8px", fontSize: 11 }} onClick={() => setEditBuildMeta({ key: selectedBuild, name: currentBuild.name, description: currentBuild.description || "" })}>✎ Rename</button></h2>
                  <div style={{ fontSize: 13, color: THEME.textMuted, marginTop: 4 }}>{currentBuild.description} · {currentBuild.parts?.length || 0} parts</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditingSummary(true)}>Edit Pricing</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => duplicateBuild(selectedBuild)}>⧉ Copy</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setShowPartsPicker(true); setPartsPickerSearch(""); }}>📋 Pick from Library</button>
                    <button className="btn btn-primary btn-sm" onClick={() => setEditingPart({ idx: -1, part: { part_number: "", description: "", qty: 1, unit: "Each", price_ea: 0, currency: "CAD", vendor: "", retail_pn: "", mfg_pn: "", is_build: false } })}>+ New Part</button>
                  <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete({ type: "build", key: selectedBuild })}>Delete</button>
                </div>
              </div>

              {calc && (<div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 20 }}>
                {[["Material Cost", fmtCurr(calc.matCost)], ["Factory Cost", fmtCurr(calc.factoryCost)], ["Min. Sell (CAD)", fmtCurr(calc.minSellCAD), THEME.orange], ["Min. Sell (EUR)", fmtCurr(calc.minSellEUR, "€")], ["Actual (CAD)", calc.actualCAD != null ? fmtCurr(calc.actualCAD) : "—", calc.actualCAD ? THEME.green : THEME.textDim], ["GM%", calc.gm != null ? `${(calc.gm*100).toFixed(1)}%` : "—", calc.gm != null ? (calc.gm >= 0.5 ? THEME.green : calc.gm >= 0.3 ? THEME.orange : THEME.red) : THEME.textDim]].map(([l, v, c]) => (
                  <div key={l} className="stat-card"><div style={{ fontSize: 11, color: THEME.textDim, marginBottom: 4 }}>{l}</div><div style={{ fontSize: 16, fontWeight: 600, color: c || THEME.text }}>{v}</div></div>
                ))}
              </div>)}

              {calc && calc.zeroCostCount > 0 && (<div style={{ background: "rgba(255,107,107,0.06)", border: `1px solid rgba(255,107,107,0.2)`, borderRadius: 10, padding: "10px 16px", marginBottom: 16, fontSize: 13, color: THEME.red }}>⚠ {calc.zeroCostCount} part{calc.zeroCostCount > 1 ? "s" : ""} with zero cost</div>)}

              <div className="table-wrap">
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr style={{ borderBottom: `1px solid ${THEME.border}` }}>
                    {["PART NUMBER", "QTY", "DESCRIPTION", "RETAIL PN", "MFG PN", "PRICE EA.", "LINE TOTAL", "VENDOR", ""].map(h => (
                      <th key={h} style={{ textAlign: h === "QTY" || h === "" ? "center" : h === "PRICE EA." || h === "LINE TOTAL" ? "right" : "left", padding: "10px 12px", color: THEME.textDim, fontWeight: 600, fontSize: 11 }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {(currentBuild.parts || []).map((p, i) => { const isZero = (p.price_ea || 0) === 0; const nb = p.is_build ? findBuildByName(p.part_number) : null; const isExp = expandedNested[p.part_number]; return (
                      <React.Fragment key={i}>
                        <tr className={`row-hover ${isZero ? "zero-cost" : ""}`} style={{ borderBottom: `1px solid ${THEME.border}` }}>
                          <td style={{ padding: "8px 12px" }}><span style={{ color: isZero ? THEME.red : THEME.accent, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{p.part_number}</span>{p.is_build && <span className="nested-badge" onClick={() => toggleNested(p.part_number)}>{isExp ? "▼ BUILD" : "► BUILD"}</span>}</td>
                          <td style={{ textAlign: "center", padding: "8px", fontFamily: "'JetBrains Mono', monospace" }}>{p.qty}</td>
                          <td style={{ padding: "8px 12px", color: THEME.textMuted }}>{p.description}</td>
                          <td style={{ padding: "8px 12px", color: THEME.textDim, fontSize: 11 }}>{p.retail_pn || "—"}</td>
                          <td style={{ padding: "8px 12px", color: THEME.textDim, fontSize: 11 }}>{p.mfg_pn || "—"}</td>
                          <td style={{ textAlign: "right", padding: "8px 12px", fontFamily: "'JetBrains Mono', monospace", color: isZero ? THEME.red : THEME.text }}>${fmt(p.price_ea)}</td>
                          <td style={{ textAlign: "right", padding: "8px 12px", fontFamily: "'JetBrains Mono', monospace" }}>${fmt((p.price_ea || 0) * (p.qty || 1))}</td>
                          <td style={{ padding: "8px 12px", color: THEME.textDim, fontSize: 12 }}>{p.vendor || "—"}</td>
                          <td style={{ textAlign: "center", padding: "8px" }}>
                            <button className="btn btn-ghost btn-sm" style={{ padding: "2px 6px", marginRight: 4 }} onClick={() => setEditingPart({ idx: i, part: { ...p } })}>✎</button>
                            <button className="btn btn-ghost btn-sm" style={{ padding: "2px 6px", color: THEME.red }} onClick={() => setConfirmDelete({ type: "part", buildKey: selectedBuild, idx: i })}>✕</button>
                          </td>
                        </tr>
                        {isExp && nb && (<tr><td colSpan={9} style={{ padding: 0, background: "rgba(179,136,255,0.04)" }}>
                          <div style={{ padding: "8px 16px 8px 40px", borderLeft: `3px solid ${THEME.purple}` }}>
                            <div style={{ fontSize: 11, color: THEME.purple, fontWeight: 600, marginBottom: 6 }}>Sub-build: {nb[1].name} ({nb[1].parts?.length || 0} parts)</div>
                            <table style={{ width: "100%", fontSize: 12 }}><tbody>
                              {(nb[1].parts || []).slice(0, 15).map((sp, si) => (<tr key={si} style={{ borderBottom: `1px solid rgba(179,136,255,0.08)` }}><td style={{ padding: "3px 8px", color: THEME.purple, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, width: 160 }}>{sp.part_number}</td><td style={{ padding: "3px 8px", textAlign: "center", width: 40 }}>{sp.qty}</td><td style={{ padding: "3px 8px", color: THEME.textDim }}>{sp.description}</td><td style={{ padding: "3px 8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: (sp.price_ea || 0) === 0 ? THEME.red : THEME.textMuted }}>${fmt(sp.price_ea)}</td></tr>))}
                              {(nb[1].parts || []).length > 15 && <tr><td colSpan={4} style={{ padding: "3px 8px", color: THEME.textDim, fontSize: 11 }}>+{nb[1].parts.length - 15} more</td></tr>}
                            </tbody></table>
                          </div>
                        </td></tr>)}
                      </React.Fragment>
                    ); })}
                  </tbody>
                </table>
              </div>
            </>) : (<div style={{ textAlign: "center", color: THEME.textDim, marginTop: 100, fontSize: 15 }}>Select a build from the sidebar</div>)}
          </div>
        </div>
      )}

      {/* ═══ TAB 1: PARTS LIBRARY ═══ */}
      {activeTab === 1 && (
        <div style={{ padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>Parts Library <span style={{ color: THEME.textDim, fontWeight: 400, fontSize: 14 }}>({allParts.length} unique)</span></h2>
              <button className="btn btn-primary btn-sm" onClick={() => setNewLibPart({ part_number: "", description: "", qty: 1, unit: "Each", price_ea: 0, currency: "CAD", vendor: "", retail_pn: "", mfg_pn: "", addToFG: false, sellPrice: 0, fgCategory: "" })}>+ New Part</button>
            </div>
            <input className="input-field" placeholder="Search parts..." style={{ width: 300 }} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="table-wrap">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ borderBottom: `1px solid ${THEME.border}` }}>
                {["PART NUMBER", "DESCRIPTION", "RETAIL PN", "MFG PN", "PRICE EA.", "CURRENCY", "USED IN", "VENDOR", ""].map(h => (
                  <th key={h} style={{ textAlign: h === "PRICE EA." ? "right" : h === "CURRENCY" || h === "USED IN" ? "center" : "left", padding: "10px 12px", color: THEME.textDim, fontWeight: 600, fontSize: 11 }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {allParts.filter(p => !search || p.part_number?.toLowerCase().includes(search.toLowerCase()) || p.description?.toLowerCase().includes(search.toLowerCase()) || p.retail_pn?.toLowerCase().includes(search.toLowerCase()) || p.mfg_pn?.toLowerCase().includes(search.toLowerCase())).slice(0, 200).map(p => { const isZero = (p.price_ea || 0) === 0; return (
                  <tr key={p.part_number} className={`row-hover ${isZero ? "zero-cost" : ""}`} style={{ borderBottom: `1px solid ${THEME.border}` }}>
                    <td style={{ padding: "8px 12px" }}><span style={{ color: isZero ? THEME.red : THEME.accent, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{p.part_number}</span>{p.is_build && <span className="nested-badge">BUILD</span>}</td>
                    <td style={{ padding: "8px 12px", color: THEME.textMuted }}>{p.description}</td>
                    <td style={{ padding: "8px 12px", color: THEME.textDim, fontSize: 11 }}>{p.retail_pn || "—"}</td>
                    <td style={{ padding: "8px 12px", color: THEME.textDim, fontSize: 11 }}>{p.mfg_pn || "—"}</td>
                    <td style={{ textAlign: "right", padding: "8px 12px", fontFamily: "'JetBrains Mono', monospace", color: isZero ? THEME.red : THEME.text }}>${fmt(p.price_ea)}</td>
                    <td style={{ textAlign: "center", padding: "8px 12px", fontSize: 11, color: THEME.textDim }}>{p.currency || "CAD"}</td>
                    <td style={{ textAlign: "center", padding: "8px 12px" }}><span style={{ background: THEME.accentGlow, color: THEME.accent, padding: "2px 8px", borderRadius: 10, fontSize: 11 }}>{p.systems?.length || 0}</span></td>
                    <td style={{ padding: "8px 12px", color: THEME.textDim, fontSize: 12 }}>{p.vendor || "—"}</td>
                    <td style={{ padding: "8px 12px", textAlign: "center" }}>
                      <button className="btn btn-ghost btn-sm" style={{ padding: "2px 6px", marginRight: 4 }} onClick={() => setEditingLibPart({ partNum: p.part_number, part: { ...p } })}>✎</button>
                      <button className="btn btn-ghost btn-sm" style={{ padding: "2px 6px", color: THEME.red }} onClick={() => setDeletingLibPart(p.part_number)}>✕</button>
                    </td>
                  </tr>
                ); })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══ TAB 2: FINISHED GOODS ═══ */}
      {activeTab === 2 && (
        <div style={{ padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 20 }}>Finished Goods <span style={{ color: THEME.textDim, fontWeight: 400, fontSize: 14 }}>({fgItems.length})</span></h2>
            <button className="btn btn-primary" onClick={() => setEditingFG({ idx: -1, item: { name: "", sku: "", category: "", vendor: "", cost_cad: 0, labor_mins: 15, sell_price_cad: 0, notes: "" } })}>+ Add Item</button>
          </div>
          <div className="table-wrap">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: "22%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "6%" }} />
                <col style={{ width: "4%" }} />
              </colgroup>
              <thead><tr style={{ borderBottom: `1px solid ${THEME.border}` }}>{["NAME", "SKU", "CATEGORY", "COST", "FACTORY", "MIN SELL", "SELL PRICE", "GM%", ""].map(h => (<th key={h} style={{ textAlign: ["NAME", "SKU", "CATEGORY", ""].includes(h) ? "left" : "right", padding: "10px 12px", color: THEME.textDim, fontWeight: 600, fontSize: 11 }}>{h}</th>))}</tr></thead>
              <tbody>
                {fgItems.map((item, i) => { const c = calcFGCost(item, gs); return (
                  <tr key={i} className="row-hover" style={{ borderBottom: `1px solid ${THEME.border}` }}>
                    <td style={{ padding: "8px 12px", fontWeight: 500 }}>{item.name}</td>
                    <td style={{ padding: "8px 12px", fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: THEME.accent }}>{item.sku}</td>
                    <td style={{ padding: "8px 12px", color: THEME.textDim }}>{item.category}</td>
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>{fmtCurr(item.cost_cad)}</td>
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>{fmtCurr(c.factoryCost)}</td>
                    <td style={{ padding: "8px 12px", textAlign: "right", color: THEME.orange }}>{fmtCurr(c.minSellCAD)}</td>
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>{c.actualCAD != null ? fmtCurr(c.actualCAD) : "—"}</td>
                    <td style={{ padding: "8px 12px", textAlign: "right", color: c.gm != null ? (c.gm >= 0.5 ? THEME.green : c.gm >= 0.3 ? THEME.orange : THEME.red) : THEME.textDim }}>{c.gm != null ? `${(c.gm*100).toFixed(1)}%` : "—"}</td>
                    <td style={{ padding: "8px 12px", textAlign: "center" }}>
                      <button className="btn btn-ghost btn-sm" style={{ padding: "2px 6px", marginRight: 4 }} onClick={() => setEditingFG({ idx: i, item: { ...item } })}>✎</button>
                      <button className="btn btn-ghost btn-sm" style={{ padding: "2px 6px", color: THEME.red }} onClick={() => setConfirmDelete({ type: "fg", idx: i })}>✕</button>
                    </td>
                  </tr>
                ); })}
                {fgItems.length === 0 && <tr><td colSpan={9} style={{ textAlign: "center", padding: 40, color: THEME.textDim }}>No finished goods yet</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══ TAB 3: PRICING ANALYSIS ═══ */}
      {activeTab === 3 && (
        <div style={{ padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 20 }}>Pricing Analysis <span style={{ color: THEME.textDim, fontWeight: 400, fontSize: 14 }}>({Object.keys(data).filter(k => { if (!search) return true; const s = search.toLowerCase(); const b = data[k]; return b.name?.toLowerCase().includes(s) || b.description?.toLowerCase().includes(s) || (b.parts || []).some(p => p.part_number?.toLowerCase().includes(s) || p.description?.toLowerCase().includes(s)); }).length} builds)</span></h2>
            <input className="input-field" placeholder="Search builds, parts, descriptions..." style={{ width: 350 }} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="table-wrap" style={{ overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ borderBottom: `1px solid ${THEME.border}` }}>{["BUILD", "PARTS", "$0", "MAT COST", "FACTORY", "MIN SELL", "ACTUAL", "MARGIN", "GM%"].map(h => (<th key={h} style={{ textAlign: ["BUILD"].includes(h) ? "left" : "right", padding: "10px 12px", color: THEME.textDim, fontWeight: 600, fontSize: 11, whiteSpace: "nowrap" }}>{h}</th>))}</tr></thead>
              <tbody>{Object.entries(data).filter(([k, b]) => { if (!search) return true; const s = search.toLowerCase(); return b.name?.toLowerCase().includes(s) || b.description?.toLowerCase().includes(s) || (b.parts || []).some(p => p.part_number?.toLowerCase().includes(s) || p.description?.toLowerCase().includes(s)); }).map(([k, b]) => { const c = calcBuildCost(b, gs); return (
                <tr key={k} className="row-hover" style={{ borderBottom: `1px solid ${THEME.border}`, cursor: "pointer" }} onClick={() => { setSelectedBuild(k); setActiveTab(0); }}>
                  <td style={{ padding: "8px 12px", maxWidth: 250, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><span style={{ fontWeight: 500 }}>{b.name}</span>{c.nestedCount > 0 && <span style={{ color: THEME.purple, fontSize: 10, marginLeft: 4 }}>◆</span>}</td>
                  <td style={{ padding: "8px 12px", textAlign: "center" }}>{b.parts?.length || 0}</td>
                  <td style={{ padding: "8px 12px", textAlign: "center", color: c.zeroCostCount > 0 ? THEME.red : THEME.green }}>{c.zeroCostCount}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>{fmtCurr(c.matCost)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>{fmtCurr(c.factoryCost)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", color: THEME.orange }}>{fmtCurr(c.minSellCAD)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>{c.actualCAD != null ? fmtCurr(c.actualCAD) : "—"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>{c.margin != null ? fmtCurr(c.margin) : "—"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", color: c.gm != null ? (c.gm >= 0.5 ? THEME.green : c.gm >= 0.3 ? THEME.orange : THEME.red) : THEME.textDim }}>{c.gm != null ? `${(c.gm*100).toFixed(1)}%` : "—"}</td>
                </tr>
              ); })}</tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══ TAB 4: PRICE LISTS ═══ */}
      {activeTab === 4 && !selectedPriceList && (
        <div style={{ padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 20 }}>Price Lists</h2>
            <button className="btn btn-primary" onClick={() => setEditingPriceList({ idx: -1, pl: { id: `pl_${Date.now()}`, name: "", currency: "CAD", fxRate: 1, fxBase: "CAD", shippingDefault: 0, shippingAbsorbed: false, discountPct: 0, notes: "", systemOverrides: {}, includedBuilds: [], includedFG: [] } })}>+ New Price List</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))", gap: 20 }}>
            {priceLists.map((pl, i) => {
              // Calculate KPIs
              const totalItems = (pl.includedBuilds || []).length + (pl.includedFG || []).length;
              let totalRevenue = 0, totalGM = 0, gmCount = 0, missingPrice = 0, lowestGM = null, lowestGMName = "";
              (pl.includedBuilds || []).filter(k => data[k]).forEach(k => {
                const e = calcPLBuildEntry(k, data[k], pl, gs);
                if (e.hasOverride && e.baseSellNative) { totalRevenue += e.baseSellNative; }
                else { missingPrice++; }
                if (e.realGM != null) { totalGM += e.realGM; gmCount++; if (lowestGM === null || e.realGM < lowestGM) { lowestGM = e.realGM; lowestGMName = data[k].name; } }
              });
              (pl.includedFG || []).forEach(idx => {
                const item = fgItems[idx]; if (!item) return;
                const c = calcFGCost(item, gs);
                if (c.actualCAD != null) { totalRevenue += c.actualCAD * (pl.fxRate || 1); } else { missingPrice++; }
                if (c.gm != null) { totalGM += c.gm; gmCount++; if (lowestGM === null || c.gm < lowestGM) { lowestGM = c.gm; lowestGMName = item.name; } }
              });
              const avgGM = gmCount > 0 ? totalGM / gmCount : null;
              const sym = CURRENCY_SYMBOLS[pl.currency] || pl.currency + " ";

              return (<div key={pl.id} className="card" style={{ padding: 0, cursor: "pointer", transition: "all 0.2s", overflow: "hidden" }} onClick={() => { setSelectedPriceList(pl.id); setTestDiscount(0); setShowMarginAnalysis(false); }}>
                {/* Header */}
                <div style={{ padding: "16px 20px", borderBottom: `1px solid ${THEME.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>{pl.name}</div>
                    <span style={{ background: THEME.accentGlow, color: THEME.accent, padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600 }}>{pl.currency}</span>
                  </div>
                  <div style={{ fontSize: 12, color: THEME.textDim }}>{pl.notes || `FX: ${pl.fxRate} · Shipping: $${pl.shippingDefault}${pl.shippingAbsorbed ? " (absorbed)" : ""}`}</div>
                </div>

                {/* KPIs */}
                <div style={{ padding: "12px 20px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 10, color: THEME.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>Items</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: THEME.text }}>{totalItems}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: THEME.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>Avg GM%</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: avgGM != null ? (avgGM >= 0.5 ? THEME.green : avgGM >= 0.3 ? THEME.orange : THEME.red) : THEME.textDim }}>{avgGM != null ? `${(avgGM * 100).toFixed(1)}%` : "—"}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: THEME.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>Revenue</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: THEME.text }}>{totalRevenue > 0 ? fmtCurr(totalRevenue, sym) : "—"}</div>
                  </div>
                </div>

                {/* Alerts */}
                {(missingPrice > 0 || lowestGM !== null) && (
                  <div style={{ padding: "0 20px 12px", display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {missingPrice > 0 && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "rgba(255,167,38,0.1)", color: THEME.orange }}>{missingPrice} missing price</span>}
                    {lowestGM !== null && lowestGM < 0.3 && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "rgba(255,107,107,0.1)", color: THEME.red }}>Low: {lowestGMName?.substring(0, 20)} ({(lowestGM * 100).toFixed(0)}%)</span>}
                  </div>
                )}

                {/* Actions */}
                <div style={{ padding: "12px 20px", borderTop: `1px solid ${THEME.border}`, display: "flex", gap: 6 }}>
                  <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setEditingPriceList({ idx: i, pl: { ...pl } }); }}>Edit</button>
                  <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setManagingPLItems(i); }}>Manage</button>
                  <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setDuplicatingPL({ idx: i, name: `${pl.name} (Copy)`, currency: pl.currency }); }}>⧉ Duplicate</button>
                  <button className="btn btn-ghost btn-sm" style={{ color: THEME.red }} onClick={(e) => { e.stopPropagation(); persistPL(priceLists.filter((_, j) => j !== i)); showToast("Deleted", "warn"); }}>Delete</button>
                </div>
              </div>);
            })}
          </div>
        </div>
      )}

      {/* Price List Detail View */}
      {activeTab === 4 && selectedPriceList && activePL && (
        <div style={{ padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <div>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedPriceList(null)} style={{ marginBottom: 8 }}>← Back to Price Lists</button>
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{activePL.name} <span style={{ fontSize: 14, fontWeight: 400, color: THEME.textDim }}>{activePL.currency} · FX {activePL.fxRate}</span></h2>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setManagingPLItems(activePLIndex)}>Manage Items</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditingPriceList({ idx: activePLIndex, pl: { ...activePL } })}>Edit Settings</button>
              <button className={`btn btn-sm ${showMarginAnalysis ? "btn-primary" : "btn-ghost"}`} onClick={() => setShowMarginAnalysis(!showMarginAnalysis)}>📊 Margin Analysis</button>
            </div>
          </div>

          {/* Discount Slider */}
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16, padding: "12px 20px", background: THEME.surface, border: `1px solid ${THEME.border}`, borderRadius: 10 }}>
            <span style={{ fontSize: 13, color: THEME.textMuted, fontWeight: 500, whiteSpace: "nowrap" }}>Test Discount:</span>
            <input type="range" min="0" max="50" step="1" value={testDiscount} onChange={e => setTestDiscount(parseInt(e.target.value))} style={{ flex: 1, accentColor: THEME.accent }} />
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input className="input-field" type="number" min="0" max="100" step="1" value={testDiscount} onChange={e => setTestDiscount(Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))} style={{ width: 60, textAlign: "center", padding: "4px 8px" }} />
              <span style={{ color: THEME.textDim, fontSize: 13 }}>%</span>
            </div>
          </div>

          {/* Margin Analysis Panel */}
          {showMarginAnalysis && (() => {
            const items = [];
            (activePL.includedBuilds || []).filter(k => data[k]).forEach(k => {
              const e = calcPLBuildEntry(k, data[k], activePL, gs);
              if (e.hasOverride) {
                const discounted = e.baseSellNative * (1 - testDiscount / 100);
                const discRevCAD = discounted / (activePL.fxRate || 1);
                const discMargin = discRevCAD - e.factoryCost;
                const discGM = discRevCAD > 0 ? discMargin / discRevCAD : null;
                items.push({ name: data[k].name, type: "Build", sellPrice: e.baseSellNative, discounted, factoryCost: e.factoryCost, origGM: e.realGM, discGM, discMargin, sym: e.sym });
              }
            });
            (activePL.includedFG || []).forEach(idx => {
              const item = fgItems[idx]; if (!item) return;
              const c = calcFGCost(item, gs);
              if (c.actualCAD != null) {
                const sellNative = c.actualCAD * (activePL.fxRate || 1);
                const sym = CURRENCY_SYMBOLS[activePL.currency] || activePL.currency + " ";
                const discounted = sellNative * (1 - testDiscount / 100);
                const discRevCAD = discounted / (activePL.fxRate || 1);
                const discMargin = discRevCAD - c.factoryCost;
                const discGM = discRevCAD > 0 ? discMargin / discRevCAD : null;
                items.push({ name: item.name, type: "FG", sellPrice: sellNative, discounted, factoryCost: c.factoryCost, origGM: c.gm, discGM, discMargin, sym });
              }
            });
            const profitable = items.filter(i => i.discGM != null && i.discGM > 0).length;
            const atRisk = items.filter(i => i.discGM != null && i.discGM > 0 && i.discGM < 0.2).length;
            const unprofitable = items.filter(i => i.discGM != null && i.discGM <= 0).length;
            const avgDiscGM = items.length > 0 ? items.reduce((s, i) => s + (i.discGM || 0), 0) / items.length : null;
            const totalDiscRevenue = items.reduce((s, i) => s + i.discounted, 0);

            return (
              <div style={{ background: THEME.surface, border: `1px solid ${THEME.border}`, borderRadius: 10, padding: 20, marginBottom: 20 }}>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: THEME.accent }}>📊 Margin Analysis at {testDiscount}% Discount</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20 }}>
                  {[
                    ["Items Priced", `${items.length}`, THEME.text],
                    ["Avg GM% After", avgDiscGM != null ? `${(avgDiscGM * 100).toFixed(1)}%` : "—", avgDiscGM != null ? (avgDiscGM >= 0.3 ? THEME.green : avgDiscGM >= 0.15 ? THEME.orange : THEME.red) : THEME.textDim],
                    ["Revenue After", fmtCurr(totalDiscRevenue, CURRENCY_SYMBOLS[activePL.currency] || ""), THEME.text],
                    ["At Risk (<20%)", `${atRisk}`, atRisk > 0 ? THEME.orange : THEME.green],
                    ["Unprofitable", `${unprofitable}`, unprofitable > 0 ? THEME.red : THEME.green],
                  ].map(([l, v, c]) => (
                    <div key={l} className="stat-card"><div style={{ fontSize: 10, color: THEME.textDim, marginBottom: 4, textTransform: "uppercase" }}>{l}</div><div style={{ fontSize: 18, fontWeight: 700, color: c }}>{v}</div></div>
                  ))}
                </div>
                {/* Flagged items */}
                {items.filter(i => i.discGM != null && i.discGM < 0.2).length > 0 && (
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: THEME.orange, marginBottom: 8 }}>⚠ Items below 20% GM after {testDiscount}% discount:</div>
                    <div className="table-wrap">
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, tableLayout: "fixed" }}>
                        <colgroup><col style={{ width: "30%" }} /><col style={{ width: "10%" }} /><col style={{ width: "15%" }} /><col style={{ width: "15%" }} /><col style={{ width: "15%" }} /><col style={{ width: "15%" }} /></colgroup>
                        <thead><tr style={{ borderBottom: `1px solid ${THEME.border}` }}>{["ITEM", "TYPE", "LIST PRICE", "AFTER DISC.", "MARGIN (CAD)", "GM% AFTER"].map(h => (<th key={h} style={{ padding: "8px 10px", color: THEME.textDim, fontWeight: 600, fontSize: 10, textAlign: h === "ITEM" || h === "TYPE" ? "left" : "right" }}>{h}</th>))}</tr></thead>
                        <tbody>{items.filter(i => i.discGM != null && i.discGM < 0.2).sort((a, b) => (a.discGM || 0) - (b.discGM || 0)).map((item, idx) => (
                          <tr key={idx} style={{ borderBottom: `1px solid ${THEME.border}`, background: (item.discGM || 0) <= 0 ? "rgba(255,107,107,0.06)" : "transparent" }}>
                            <td style={{ padding: "6px 10px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</td>
                            <td style={{ padding: "6px 10px" }}><span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: item.type === "Build" ? THEME.accentGlow : "rgba(0,201,167,0.1)", color: item.type === "Build" ? THEME.accent : THEME.green }}>{item.type}</span></td>
                            <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{fmtCurr(item.sellPrice, item.sym)}</td>
                            <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: THEME.orange }}>{fmtCurr(item.discounted, item.sym)}</td>
                            <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: (item.discMargin || 0) < 0 ? THEME.red : THEME.text }}>{fmtCurr(item.discMargin)}</td>
                            <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600, color: (item.discGM || 0) <= 0 ? THEME.red : THEME.orange }}>{item.discGM != null ? `${(item.discGM * 100).toFixed(1)}%` : "—"}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* ─── Price List Content ─── */}
          {(() => {
            // Collect all items into categories
            const allItems = [];
            
            // Add builds
            (activePL.includedBuilds || []).filter(k => data[k]).forEach(k => {
              const e = calcPLBuildEntry(k, data[k], activePL, gs);
              allItems.push({
                type: "build",
                key: k,
                name: data[k].name,
                category: data[k].category || data[k].summary?.category || "Uncategorized",
                factoryCost: e.factoryCost,
                minSell: e.minSellNative,
                sellPrice: e.hasOverride ? e.baseSellNative : null,
                margin: e.realMarginCAD,
                gm: e.realGM,
                sym: e.sym,
                hasOverride: e.hasOverride,
              });
            });
            
            // Add FG items
            (activePL.includedFG || []).map(idx => {
              const item = fgItems[idx];
              if (!item) return;
              const c = calcFGCost(item, gs);
              const fxRate = activePL.fxRate ?? 1;
              const sym = CURRENCY_SYMBOLS[activePL.currency] || activePL.currency + " ";
              allItems.push({
                type: "fg",
                key: `fg-${idx}`,
                fgIdx: idx,
                name: item.name,
                sku: item.sku,
                category: item.category || "Uncategorized",
                factoryCost: c.factoryCost,
                minSell: c.minSellCAD * fxRate,
                sellPrice: c.actualCAD != null ? c.actualCAD * fxRate : null,
                margin: c.margin,
                gm: c.gm,
                sym: sym,
                hasOverride: c.actualCAD != null,
              });
            });
            
            if (allItems.length === 0) return null;
            
            // Group by category
            const byCategory = {};
            allItems.forEach(item => {
              if (!byCategory[item.category]) byCategory[item.category] = [];
              byCategory[item.category].push(item);
            });
            const cats = Object.keys(byCategory).sort((a, b) => a === "Uncategorized" ? 1 : b === "Uncategorized" ? -1 : a.localeCompare(b));
            
            const colStyle = { padding: "9px 14px" };
            const headerStyle = { ...colStyle, color: THEME.textDim, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${THEME.border}` };
            
            return cats.map(cat => (
              <PLCategorySection key={cat} title={cat} count={byCategory[cat].length} defaultOpen={true}>
                <div className="table-wrap" style={{ marginBottom: 20 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
                    <colgroup>
                      <col style={{ width: testDiscount > 0 ? "22%" : "28%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "11%" }} />
                      <col style={{ width: "12%" }} />
                      <col style={{ width: "12%" }} />
                      <col style={{ width: "8%" }} />
                      {testDiscount > 0 && <col style={{ width: "12%" }} />}
                      {testDiscount > 0 && <col style={{ width: "8%" }} />}
                      <col style={{ width: "7%" }} />
                    </colgroup>
                    <thead><tr>
                      <th style={{ ...headerStyle, textAlign: "left" }}>ITEM</th>
                      <th style={{ ...headerStyle, textAlign: "left" }}>TYPE</th>
                      <th style={{ ...headerStyle, textAlign: "right" }}>FACTORY</th>
                      <th style={{ ...headerStyle, textAlign: "right" }}>{`MIN SELL`}</th>
                      <th style={{ ...headerStyle, textAlign: "right" }}>{`SELL PRICE`}</th>
                      <th style={{ ...headerStyle, textAlign: "right" }}>GM%</th>
                      {testDiscount > 0 && <th style={{ ...headerStyle, textAlign: "right", color: THEME.orange }}>{`-${testDiscount}%`}</th>}
                      {testDiscount > 0 && <th style={{ ...headerStyle, textAlign: "right", color: THEME.orange }}>GM% After</th>}
                      <th style={{ ...headerStyle, textAlign: "right" }}></th>
                    </tr></thead>
                    <tbody>
                      {byCategory[cat].map(item => (
                        <tr key={item.key} className="row-hover" style={{ borderBottom: `1px solid ${THEME.border}` }}>
                          <td style={{ ...colStyle, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            <div style={{ fontWeight: 500 }}>{item.name}</div>
                            {item.sku && <div style={{ fontSize: 11, color: THEME.accent, fontFamily: "'JetBrains Mono', monospace", marginTop: 1 }}>{item.sku}</div>}
                            {item.type === "build" && (
                              <div style={{ marginTop: 2 }}>
                                <span onClick={(e) => { e.stopPropagation(); setEditBuildMeta({ key: item.key, name: data[item.key]?.name || "", description: data[item.key]?.description || "", category: item.category === "Uncategorized" ? "" : item.category }); }}
                                  style={{ fontSize: 10, cursor: "pointer", padding: "1px 6px", borderRadius: 3, background: item.category === "Uncategorized" ? "rgba(255,167,38,0.1)" : "rgba(0,180,216,0.1)", color: item.category === "Uncategorized" ? THEME.orange : THEME.accent }}>
                                  {item.category === "Uncategorized" ? "+ Set category" : `${item.category} ✎`}
                                </span>
                              </div>
                            )}
                            {item.type === "fg" && (
                              <div style={{ marginTop: 2 }}>
                                <span onClick={(e) => { e.stopPropagation(); setEditingFG({ idx: item.fgIdx, item: { ...fgItems[item.fgIdx] } }); }}
                                  style={{ fontSize: 10, cursor: "pointer", padding: "1px 6px", borderRadius: 3, background: item.category === "Uncategorized" ? "rgba(255,167,38,0.1)" : "rgba(0,201,167,0.1)", color: item.category === "Uncategorized" ? THEME.orange : THEME.green }}>
                                  {item.category === "Uncategorized" ? "+ Set category" : `${item.category} ✎`}
                                </span>
                              </div>
                            )}
                          </td>
                          <td style={{ ...colStyle, textAlign: "left" }}>
                            <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: item.type === "build" ? THEME.accentGlow : "rgba(0,201,167,0.1)", color: item.type === "build" ? THEME.accent : THEME.green }}>{item.type === "build" ? "Build" : "FG"}</span>
                          </td>
                          <td style={{ ...colStyle, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{fmtCurr(item.factoryCost)}</td>
                          <td style={{ ...colStyle, textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: THEME.orange }}>{fmtCurr(item.minSell, item.sym)}</td>
                          <td style={{ ...colStyle, textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: item.hasOverride ? THEME.green : THEME.textDim }}>{item.sellPrice != null ? fmtCurr(item.sellPrice, item.sym) : "—"}</td>
                          <td style={{ ...colStyle, textAlign: "right", fontWeight: 600, color: item.gm != null ? (item.gm >= 0.5 ? THEME.green : item.gm >= 0.3 ? THEME.orange : THEME.red) : THEME.textDim }}>{item.gm != null ? `${(item.gm * 100).toFixed(1)}%` : "—"}</td>
                          {testDiscount > 0 && (() => {
                            const sp = item.sellPrice || item.minSell;
                            const disc = sp ? sp * (1 - testDiscount / 100) : null;
                            const discRevCAD = disc ? disc / (activePL.fxRate || 1) : null;
                            const discGM = discRevCAD && discRevCAD > 0 ? (discRevCAD - item.factoryCost) / discRevCAD : null;
                            return (<>
                              <td style={{ ...colStyle, textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: THEME.orange }}>{disc != null ? fmtCurr(disc, item.sym) : "—"}</td>
                              <td style={{ ...colStyle, textAlign: "right", fontWeight: 600, color: discGM != null ? (discGM >= 0.3 ? THEME.green : discGM >= 0.15 ? THEME.orange : THEME.red) : THEME.textDim }}>{discGM != null ? `${(discGM * 100).toFixed(1)}%` : "—"}</td>
                            </>);
                          })()}
                          <td style={{ ...colStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                            {item.type === "build" && <button className="btn btn-ghost btn-sm" style={{ padding: "2px 8px", marginRight: 2, fontSize: 11 }} onClick={() => setEditingPLOverride({ plIdx: activePLIndex, buildKey: item.key, current: activePL.systemOverrides?.[item.key]?.sellPrice ?? "" })}>Set Price</button>}
                            {item.type === "fg" && <button className="btn btn-ghost btn-sm" style={{ padding: "2px 8px", marginRight: 2, fontSize: 11 }} onClick={() => setEditingFG({ idx: item.fgIdx, item: { ...fgItems[item.fgIdx] } })}>Edit</button>}
                            <button className="btn btn-ghost btn-sm" style={{ padding: "2px 6px", color: THEME.red, fontSize: 11 }} onClick={() => item.type === "build" ? toggleBuildInPL(activePLIndex, item.key) : toggleFGInPL(activePLIndex, item.fgIdx)} title="Remove">✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </PLCategorySection>
            ));
          })()}

          {(activePL.includedBuilds || []).length === 0 && (activePL.includedFG || []).length === 0 && (
            <div style={{ textAlign: "center", padding: 60, color: THEME.textDim }}>
              <div style={{ fontSize: 16, marginBottom: 8 }}>No items in this price list yet</div>
              <button className="btn btn-primary" onClick={() => setManagingPLItems(activePLIndex)}>Add Builds & Products</button>
            </div>
          )}
        </div>
      )}

      {/* ═══ MODALS ═══ */}

      {/* Edit Part */}
      {editingPart && (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div className="card" style={{ padding: 24, width: 520, maxWidth: "90vw", maxHeight: "90vh", overflowY: "auto" }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>{editingPart.idx === -1 ? "Add Part" : "Edit Part"}</h3>
          {[["Part Number", "part_number", "text"], ["Description", "description", "text"], ["Qty", "qty", "number"], ["Unit", "unit", "text"], ["Price Each", "price_ea", "number"], ["Vendor", "vendor", "text"], ["Retail Part Number", "retail_pn", "text"], ["Manufacturer Part Number", "mfg_pn", "text"]].map(([l, k, t]) => (
            <div key={k} style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>{l}</label><input className="input-field" type={t} step={t === "number" ? "0.01" : undefined} value={editingPart.part[k] ?? ""} onChange={e => setEditingPart(prev => ({ ...prev, part: { ...prev.part, [k]: t === "number" ? parseFloat(e.target.value) || 0 : e.target.value } }))} /></div>
          ))}
          <div style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>Currency</label><select className="input-field" value={editingPart.part.currency || "CAD"} onChange={e => setEditingPart(prev => ({ ...prev, part: { ...prev.part, currency: e.target.value } }))}>{Object.keys(CURRENCY_SYMBOLS).map(c => <option key={c} value={c}>{c}</option>)}</select></div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}><button className="btn btn-ghost" onClick={() => setEditingPart(null)}>Cancel</button><button className="btn btn-primary" onClick={() => savePart(selectedBuild, editingPart.idx, editingPart.part)}>Save</button></div>
        </div>
      </div>)}

      {/* Edit Lib Part */}
      {editingLibPart && (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div className="card" style={{ padding: 24, width: 520, maxWidth: "90vw" }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>Edit Part (updates all builds)</h3>
          {[["Part Number", "part_number", "text"], ["Description", "description", "text"], ["Price Each", "price_ea", "number"], ["Vendor", "vendor", "text"], ["Retail Part Number", "retail_pn", "text"], ["Manufacturer Part Number", "mfg_pn", "text"]].map(([l, k, t]) => (
            <div key={k} style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>{l}</label><input className="input-field" type={t} step={t === "number" ? "0.01" : undefined} value={editingLibPart.part[k] ?? ""} onChange={e => setEditingLibPart(prev => ({ ...prev, part: { ...prev.part, [k]: t === "number" ? parseFloat(e.target.value) || 0 : e.target.value } }))} /></div>
          ))}
          <div style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>Currency</label><select className="input-field" value={editingLibPart.part.currency || "CAD"} onChange={e => setEditingLibPart(prev => ({ ...prev, part: { ...prev.part, currency: e.target.value } }))}>{Object.keys(CURRENCY_SYMBOLS).map(c => <option key={c} value={c}>{c}</option>)}</select></div>
          <div style={{ fontSize: 12, color: THEME.textDim, marginBottom: 16 }}>Used in {editingLibPart.part.systems?.length || 0} builds</div>

          {/* Promote to Finished Good section */}
          <div style={{ borderTop: `1px solid ${THEME.border}`, paddingTop: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: THEME.green, marginBottom: 10 }}>
              {fgItems.some(fg => fg.sku === editingLibPart.partNum) ? "✓ Already a Finished Good" : "Promote to Finished Good"}
            </div>
            {!fgItems.some(fg => fg.sku === editingLibPart.partNum) && (<>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>Sell Price (CAD)</label><input className="input-field" type="number" step="0.01" id="promote_sell_price" placeholder="0.00" /></div>
                <div><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>Category</label><input className="input-field" type="text" id="promote_category" placeholder="e.g. Lamps, Filters" /></div>
              </div>
              <button className="btn btn-green btn-sm" onClick={() => { const sp = parseFloat(document.getElementById('promote_sell_price').value) || 0; const cat = document.getElementById('promote_category').value || ''; promoteToFG(editingLibPart.part, sp, cat); }}>Add to Finished Goods</button>
            </>)}
          </div>

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}><button className="btn btn-ghost" onClick={() => setEditingLibPart(null)}>Cancel</button><button className="btn btn-primary" onClick={() => saveLibPart(editingLibPart.partNum, editingLibPart.part)}>Save Everywhere</button></div>
        </div>
      </div>)}

      {/* Pricing Config */}
      {editingSummary && currentBuild && (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div className="card" style={{ padding: 24, width: 500 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>Pricing Config: {currentBuild.name}</h3>
          {[["Labor Rate ($/hr)", "labor_rate", currentBuild.summary?.labor_rate ?? gs.laborRate], ["O/H Multiplier", "oh_rate", currentBuild.summary?.oh_rate ?? gs.ohRate], ["Labor Minutes", "labor_mins", currentBuild.summary?.labor_mins ?? gs.defaultLaborMins], ["Markup", "markup", currentBuild.summary?.markup ?? gs.markup], ["Actual Price (CAD)", "actual_price_cad", currentBuild.summary?.actual_price_cad ?? ""]].map(([l, k, v]) => (
            <div key={k} style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>{l}</label><input className="input-field" type="number" step="0.01" defaultValue={v} id={`sum_${k}`} /></div>
          ))}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}><button className="btn btn-ghost" onClick={() => setEditingSummary(false)}>Cancel</button><button className="btn btn-primary" onClick={() => { const g = k => { const v = document.getElementById(`sum_${k}`).value; return v === "" ? undefined : parseFloat(v); }; saveSummary(selectedBuild, { labor_rate: g("labor_rate"), oh_rate: g("oh_rate"), labor_mins: g("labor_mins"), markup: g("markup"), actual_price_cad: g("actual_price_cad") }); }}>Save</button></div>
        </div>
      </div>)}

      {/* FG Edit */}
      {editingFG && (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div className="card" style={{ padding: 24, width: 500 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>{editingFG.idx === -1 ? "Add Finished Good" : "Edit Finished Good"}</h3>
          {[["Name", "name", "text"], ["SKU", "sku", "text"], ["Category", "category", "text"], ["Vendor", "vendor", "text"], ["Cost (CAD)", "cost_cad", "number"], ["Labor Minutes", "labor_mins", "number"], ["Sell Price (CAD)", "sell_price_cad", "number"], ["Notes", "notes", "text"]].map(([l, k, t]) => (
            <div key={k} style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>{l}</label><input className="input-field" type={t} step={t === "number" ? "0.01" : undefined} value={editingFG.item[k] ?? ""} onChange={e => setEditingFG(prev => ({ ...prev, item: { ...prev.item, [k]: t === "number" ? parseFloat(e.target.value) || 0 : e.target.value } }))} /></div>
          ))}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}><button className="btn btn-ghost" onClick={() => setEditingFG(null)}>Cancel</button><button className="btn btn-primary" onClick={() => saveFGItem(editingFG.idx, editingFG.item)}>Save</button></div>
        </div>
      </div>)}

      {/* Price List Edit */}
      {editingPriceList && (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div className="card" style={{ padding: 24, width: 500 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>{editingPriceList.idx === -1 ? "New Price List" : "Edit Price List"}</h3>
          {[["Name", "name", "text"], ["FX Rate", "fxRate", "number"], ["Shipping Default", "shippingDefault", "number"], ["Discount %", "discountPct", "number"], ["Notes", "notes", "text"]].map(([l, k, t]) => (
            <div key={k} style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>{l}</label><input className="input-field" type={t} step={t === "number" ? "0.01" : undefined} value={editingPriceList.pl[k] ?? ""} onChange={e => setEditingPriceList(prev => ({ ...prev, pl: { ...prev.pl, [k]: t === "number" ? parseFloat(e.target.value) || 0 : e.target.value } }))} /></div>
          ))}
          <div style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>Currency</label><select className="input-field" value={editingPriceList.pl.currency || "CAD"} onChange={e => setEditingPriceList(prev => ({ ...prev, pl: { ...prev.pl, currency: e.target.value } }))}>{Object.keys(CURRENCY_SYMBOLS).map(c => <option key={c} value={c}>{c}</option>)}</select></div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: THEME.textMuted, cursor: "pointer", marginBottom: 12 }}><input type="checkbox" checked={editingPriceList.pl.shippingAbsorbed || false} onChange={e => setEditingPriceList(prev => ({ ...prev, pl: { ...prev.pl, shippingAbsorbed: e.target.checked } }))} /> Shipping absorbed</label>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}><button className="btn btn-ghost" onClick={() => setEditingPriceList(null)}>Cancel</button><button className="btn btn-primary" onClick={() => { const next = [...priceLists]; if (editingPriceList.idx === -1) next.push(editingPriceList.pl); else next[editingPriceList.idx] = editingPriceList.pl; persistPL(next); setEditingPriceList(null); showToast("Saved"); }}>Save</button></div>
        </div>
      </div>)}

      {/* PL Override */}
      {editingPLOverride && (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div className="card" style={{ padding: 24, width: 400 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>Set Sell Price Override</h3>
          <p style={{ fontSize: 13, color: THEME.textMuted, marginBottom: 12 }}>{data[editingPLOverride.buildKey]?.name}</p>
          <div style={{ marginBottom: 12 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>Sell Price ({priceLists[editingPLOverride.plIdx]?.currency})</label><input className="input-field" type="number" step="0.01" defaultValue={editingPLOverride.current} id="pl_override_price" placeholder="Leave empty to use min sell" /></div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}><button className="btn btn-ghost" onClick={() => setEditingPLOverride(null)}>Cancel</button><button className="btn btn-primary" onClick={() => savePLOverride(editingPLOverride.plIdx, editingPLOverride.buildKey, document.getElementById("pl_override_price").value)}>Save</button></div>
        </div>
      </div>)}

      {/* Manage PL Items */}
      {managingPLItems !== null && priceLists[managingPLItems] && (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div className="card" style={{ padding: 24, width: 700, maxWidth: "95vw", maxHeight: "85vh", overflowY: "auto" }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>Manage Items: {priceLists[managingPLItems].name}</h3>
          <input className="input-field" placeholder="Search builds & products..." value={plSearch} onChange={e => setPlSearch(e.target.value)} style={{ marginBottom: 16 }} />

          <div style={{ fontSize: 14, fontWeight: 600, color: THEME.accent, marginBottom: 8 }}>Builds</div>
          <div style={{ maxHeight: 250, overflowY: "auto", marginBottom: 20, border: `1px solid ${THEME.border}`, borderRadius: 8 }}>
            {Object.entries(data).filter(([k, b]) => !plSearch || b.name?.toLowerCase().includes(plSearch.toLowerCase()) || b.description?.toLowerCase().includes(plSearch.toLowerCase())).map(([k, b]) => {
              const included = (priceLists[managingPLItems].includedBuilds || []).includes(k);
              return (<div key={k} onClick={() => toggleBuildInPL(managingPLItems, k)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", cursor: "pointer", borderBottom: `1px solid ${THEME.border}`, background: included ? THEME.accentGlow : "transparent" }}>
                <span style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${included ? THEME.accent : THEME.border}`, background: included ? THEME.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{included ? "✓" : ""}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.name}</div>
                  <div style={{ fontSize: 11, color: THEME.textDim }}>{b.parts?.length || 0} parts · FC {fmtCurr(calcBuildCost(b, gs).factoryCost)}</div>
                </div>
              </div>);
            })}
          </div>

          <div style={{ fontSize: 14, fontWeight: 600, color: THEME.green, marginBottom: 8 }}>Finished Goods</div>
          <div style={{ maxHeight: 200, overflowY: "auto", border: `1px solid ${THEME.border}`, borderRadius: 8 }}>
            {fgItems.length === 0 ? <div style={{ padding: 20, textAlign: "center", color: THEME.textDim }}>No finished goods added yet</div> :
            fgItems.filter((item) => !plSearch || item.name?.toLowerCase().includes(plSearch.toLowerCase()) || item.sku?.toLowerCase().includes(plSearch.toLowerCase())).map((item, idx) => {
              const included = (priceLists[managingPLItems].includedFG || []).includes(idx);
              return (<div key={idx} onClick={() => toggleFGInPL(managingPLItems, idx)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", cursor: "pointer", borderBottom: `1px solid ${THEME.border}`, background: included ? "rgba(0,201,167,0.08)" : "transparent" }}>
                <span style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${included ? THEME.green : THEME.border}`, background: included ? THEME.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{included ? "✓" : ""}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{item.name}</div>
                  <div style={{ fontSize: 11, color: THEME.textDim }}>{item.sku} · {fmtCurr(item.cost_cad)}</div>
                </div>
              </div>);
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}><button className="btn btn-primary" onClick={() => { setManagingPLItems(null); setPlSearch(""); }}>Done</button></div>
        </div>
      </div>)}

      {/* Confirm Delete */}
      {confirmDelete && (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div className="card" style={{ padding: 24, width: 400 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16, color: THEME.red }}>Confirm Delete</h3>
          <p style={{ fontSize: 14, color: THEME.textMuted, marginBottom: 20 }}>This cannot be undone.</p>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}><button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>Cancel</button><button className="btn btn-danger" onClick={() => { if (confirmDelete.type === "build") deleteBuild(confirmDelete.key); else if (confirmDelete.type === "part") deletePart(confirmDelete.buildKey, confirmDelete.idx); else if (confirmDelete.type === "fg") deleteFGItem(confirmDelete.idx); }}>Delete</button></div>
        </div>
      </div>)}

      {deletingLibPart && (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div className="card" style={{ padding: 24, width: 400 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16, color: THEME.red }}>Delete "{deletingLibPart}" from ALL builds?</h3>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}><button className="btn btn-ghost" onClick={() => setDeletingLibPart(null)}>Cancel</button><button className="btn btn-danger" onClick={() => deleteLibPart(deletingLibPart)}>Delete Everywhere</button></div>
        </div>
      </div>)}

      {/* Duplicate Price List Modal */}
      {duplicatingPL && (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div className="card" style={{ padding: 24, width: 450 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>Duplicate Price List</h3>
          <div style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>New Name</label><input className="input-field" value={duplicatingPL.name} onChange={e => setDuplicatingPL(prev => ({ ...prev, name: e.target.value }))} /></div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>Currency (sell prices will auto-convert)</label>
            <select className="input-field" value={duplicatingPL.currency} onChange={e => setDuplicatingPL(prev => ({ ...prev, currency: e.target.value }))}>
              {Object.keys(CURRENCY_SYMBOLS).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {duplicatingPL.currency !== priceLists[duplicatingPL.idx]?.currency && (
            <div style={{ fontSize: 12, color: THEME.accent, background: THEME.accentGlow, padding: "8px 12px", borderRadius: 6, marginBottom: 16 }}>
              Sell prices will convert from {priceLists[duplicatingPL.idx]?.currency} → {duplicatingPL.currency} using current FX rates
            </div>
          )}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button className="btn btn-ghost" onClick={() => setDuplicatingPL(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => { duplicatePriceList(duplicatingPL.idx, duplicatingPL.name, duplicatingPL.currency); setDuplicatingPL(null); }}>Create</button>
          </div>
        </div>
      </div>)}

      {/* Parts Picker Modal */}
      {showPartsPicker && (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div className="card" style={{ padding: 24, width: 650, maxWidth: "95vw", maxHeight: "85vh", overflowY: "auto" }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>Pick Part from Library</h3>
          <input className="input-field" placeholder="Search by part number, description..." value={partsPickerSearch} onChange={e => setPartsPickerSearch(e.target.value)} style={{ marginBottom: 16 }} autoFocus />
          <div style={{ maxHeight: 400, overflowY: "auto", border: `1px solid ${THEME.border}`, borderRadius: 8 }}>
            {allParts.filter(p => { if (!partsPickerSearch) return true; const s = partsPickerSearch.toLowerCase(); return p.part_number?.toLowerCase().includes(s) || p.description?.toLowerCase().includes(s) || p.vendor?.toLowerCase().includes(s) || p.retail_pn?.toLowerCase().includes(s) || p.mfg_pn?.toLowerCase().includes(s); }).slice(0, 50).map(p => (
              <div key={p.part_number} onClick={() => { addPartFromLibrary(p); }} className="row-hover" style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", cursor: "pointer", borderBottom: `1px solid ${THEME.border}` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: THEME.accent, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{p.part_number}</span>
                    {p.is_build && <span className="nested-badge">BUILD</span>}
                    {(p.price_ea || 0) === 0 && <span style={{ color: THEME.red, fontSize: 10, fontWeight: 600 }}>$0</span>}
                  </div>
                  <div style={{ fontSize: 12, color: THEME.textMuted, marginTop: 2 }}>{p.description}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: (p.price_ea || 0) === 0 ? THEME.red : THEME.text }}>${fmt(p.price_ea)}</div>
                  <div style={{ fontSize: 10, color: THEME.textDim }}>{p.currency || "CAD"}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}><button className="btn btn-ghost" onClick={() => setShowPartsPicker(false)}>Close</button></div>
        </div>
      </div>)}

      {/* Edit Build Name/Description Modal */}
      {editBuildMeta && (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div className="card" style={{ padding: 24, width: 500 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>Edit Build Details</h3>
          <div style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>Build Name</label><input className="input-field" value={editBuildMeta.name} onChange={e => setEditBuildMeta(prev => ({ ...prev, name: e.target.value }))} /></div>
          <div style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>Description</label><input className="input-field" value={editBuildMeta.description} onChange={e => setEditBuildMeta(prev => ({ ...prev, description: e.target.value }))} /></div>
          <div style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>Category</label><input className="input-field" value={editBuildMeta.category || ""} onChange={e => setEditBuildMeta(prev => ({ ...prev, category: e.target.value }))} placeholder="e.g. Purifiers, Systems, Mixers" /></div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}><button className="btn btn-ghost" onClick={() => setEditBuildMeta(null)}>Cancel</button><button className="btn btn-primary" onClick={saveBuildMeta}>Save</button></div>
        </div>
      </div>)}

      {/* New Part from Library Modal */}
      {newLibPart && (<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div className="card" style={{ padding: 24, width: 520, maxWidth: "90vw", maxHeight: "90vh", overflowY: "auto" }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>Create New Part</h3>
          {[["Part Number", "part_number", "text"], ["Description", "description", "text"], ["Price Each", "price_ea", "number"], ["Unit", "unit", "text"], ["Vendor", "vendor", "text"], ["Retail Part Number", "retail_pn", "text"], ["Manufacturer Part Number", "mfg_pn", "text"]].map(([l, k, t]) => (
            <div key={k} style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>{l}</label><input className="input-field" type={t} step={t === "number" ? "0.01" : undefined} value={newLibPart[k] ?? ""} onChange={e => setNewLibPart(prev => ({ ...prev, [k]: t === "number" ? parseFloat(e.target.value) || 0 : e.target.value }))} /></div>
          ))}
          <div style={{ marginBottom: 10 }}><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>Currency</label><select className="input-field" value={newLibPart.currency || "CAD"} onChange={e => setNewLibPart(prev => ({ ...prev, currency: e.target.value }))}>{Object.keys(CURRENCY_SYMBOLS).map(c => <option key={c} value={c}>{c}</option>)}</select></div>

          <div style={{ borderTop: `1px solid ${THEME.border}`, paddingTop: 16, marginTop: 16 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: THEME.textMuted, cursor: "pointer", marginBottom: 12 }}>
              <input type="checkbox" checked={newLibPart.addToFG || false} onChange={e => setNewLibPart(prev => ({ ...prev, addToFG: e.target.checked }))} />
              Also add as a Finished Good
            </label>
            {newLibPart.addToFG && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>Sell Price (CAD)</label><input className="input-field" type="number" step="0.01" value={newLibPart.sellPrice || ""} onChange={e => setNewLibPart(prev => ({ ...prev, sellPrice: parseFloat(e.target.value) || 0 }))} /></div>
                <div><label style={{ display: "block", fontSize: 12, color: THEME.textDim, marginBottom: 3 }}>Category</label><input className="input-field" value={newLibPart.fgCategory || ""} onChange={e => setNewLibPart(prev => ({ ...prev, fgCategory: e.target.value }))} placeholder="e.g. Lamps, Filters" /></div>
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => setNewLibPart(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => createNewLibPart(newLibPart, newLibPart.addToFG, newLibPart.sellPrice, newLibPart.fgCategory)}>Create Part</button>
          </div>
        </div>
      </div>)}
    </div>
  );
}
