// scripts/console_support.js
import readline from "readline";
import { CONFIG } from "../config.js"; // used by redistribute dialog
import { fmt, fmt8 } from "./symbols.js"; // formatting helpers

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m" };
function colorSideText(side) {
  if (side === "Buy") return `${ANSI.bold}${ANSI.green}${side}${ANSI.reset}`;
  if (side === "Sell") return `${ANSI.bold}${ANSI.red}${side}${ANSI.reset}`;
  return String(side ?? "");
}

export function startConsole({ actions, state, ctx }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // helper that re‑prints command list and leaves the prompt ready after
  // answering a question.  `printCommands` is hoisted so we can call it here.
  const ask = (q) =>
    new Promise((resolve) =>
      rl.question(q, (ans) => {
        const ret = String(ans ?? "").trim();
        // give user reminder of available commands and show prompt again
        try {
          printCommands();
        } catch {}
        rl.prompt();
        resolve(ret);
      })
    );
  const isQuit = (s) => String(s || "").trim().toLowerCase() === "q";
  // expose helper so callers can reuse same readline interface later
  // (actual return moved to end after event hookup)

  function has(fn) {
    return typeof fn === "function";
  }

  function printCommands() {
    console.log(
      `⌨️ commands: orders(o), regrid(r), clear(c), grid-settings(g), power(p), quit(q)`
    );
  }

  async function dialogPowerKeepAwake(arg = "") {
    if (!has(actions.setKeepAwake) || !has(actions.getKeepAwakeStatus)) {
      console.log(`⚠️ Komenda p/power wymaga actions.setKeepAwake() i actions.getKeepAwakeStatus().`);
      return;
    }

    const sub = String(arg || "").trim().toLowerCase();
    if (sub === "on" || sub === "1") {
      actions.setKeepAwake(true);
      return;
    }
    if (sub === "off" || sub === "0") {
      actions.setKeepAwake(false);
      return;
    }
    if (sub === "toggle" || sub === "t") {
      if (has(actions.toggleKeepAwake)) actions.toggleKeepAwake();
      else {
        const st = actions.getKeepAwakeStatus();
        actions.setKeepAwake(!st.enabled);
      }
      return;
    }
    if (sub === "status" || sub === "s") {
      const st = actions.getKeepAwakeStatus();
      console.log(`🔋 keep-awake status | enabled=${st.enabled ? "1" : "0"} running=${st.running ? "1" : "0"}`);
      return;
    }

    const pick = (await ask(`power: a) on b) off c) toggle d) status | q=anuluj: `)).toLowerCase();
    if (isQuit(pick)) return;
    if (pick === "a") return actions.setKeepAwake(true);
    if (pick === "b") return actions.setKeepAwake(false);
    if (pick === "c") {
      if (has(actions.toggleKeepAwake)) return actions.toggleKeepAwake();
      const st = actions.getKeepAwakeStatus();
      return actions.setKeepAwake(!st.enabled);
    }
    if (pick === "d") {
      const st = actions.getKeepAwakeStatus();
      console.log(`🔋 keep-awake status | enabled=${st.enabled ? "1" : "0"} running=${st.running ? "1" : "0"}`);
    }
  }

  async function dialogRegridFull() {
    if (!has(actions.regridFull)) {
      console.log(`⚠️ Brak actions.regridFull()`);
      return;
    }
    const ans = (await ask(`REGRID pełny? (t/n) | q=anuluj: `)).toLowerCase();
    if (isQuit(ans) || (ans !== "t" && ans !== "y")) return;
    await actions.regridFull();
  }


  async function dialogClear() {
    if (!actions.exec || !has(actions.exec.cancelAllOrders)) {
      console.log(`⚠️ Nie mogę wykonać usuwania wszystkich zleceń (brak exec.cancelAllOrders).`);
      return;
    }
    const ans = (await ask(`USUŃ WSZYSTKIE ZLECENIA? (t/n) | q=anuluj: `)).toLowerCase();
    if (isQuit(ans) || (ans !== "t" && ans !== "y")) return;
    await actions.exec.cancelAllOrders("CLEAR_CMD");
    await actions.exec.refreshOpenOrders?.();
  }


  async function dialogGridSettings() {
    if (!has(actions.getConfig) || !has(actions.updateGridSettings)) {
      console.log(`⚠️ Komenda g/grid-settings wymaga actions.getConfig() i actions.updateGridSettings().`);
      return;
    }

    const cfg = actions.getConfig();

    const microStr = await ask(
      `MICRO_SPACING_PCT (obecnie ${cfg.MICRO_SPACING_PCT}): wpisz nową | q=anuluj: `
    );
    if (isQuit(microStr)) return;

    const oqvStr = await ask(
      `ORDER_QUOTE_VALUE (obecnie ${cfg.ORDER_QUOTE_VALUE}): wpisz nową | q=anuluj: `
    );
    if (isQuit(oqvStr)) return;

    const micro = Number(microStr);
    const oqv = Number(oqvStr);

    if (!Number.isFinite(micro) || micro <= 0) {
      console.log(`⚠️ MICRO_SPACING_PCT niepoprawne`);
      return;
    }
    if (!Number.isFinite(oqv) || oqv <= 0) {
      console.log(`⚠️ ORDER_QUOTE_VALUE niepoprawne`);
      return;
    }

    actions.updateGridSettings({ microSpacingPct: micro, orderQuoteValue: oqv });
    console.log(`✅ Zmieniono ustawienia. Zadziałają od następnego filla lub po REGRID (r).`);
  }

  async function dialogRedistribute() {
    if (!has(actions.redistribute) || !actions.exec) {
      console.log(`⚠️ Komenda z/redistribute wymaga: actions.redistribute() oraz actions.exec.cancelOrderById().`);
      return;
    }

    while (true) {
      const mode = (await ask(
        `redistribute(z): a) usuń zlecenie b) dodaj zlecenie c) rozdziel wolne środki  | q=anuluj: `
      )).toLowerCase();
      if (isQuit(mode)) return;

      if (mode === "a") {
        const sideOpt = (await ask(`usuń: a) buy b) sell c) both | q=anuluj: `)).toLowerCase();
        if (isQuit(sideOpt) || !["a", "b", "c"].includes(sideOpt)) return;

        const sides = [];
        if (sideOpt === "a" || sideOpt === "c") sides.push("Buy");
        if (sideOpt === "b" || sideOpt === "c") sides.push("Sell");

        const orders = (state?.openOrders || []).filter((o) => sides.includes(o.side));
        if (!orders.length) {
          console.log(`ℹ️ brak zleceń wybranego typu`);
          return;
        }

        const priceNow = state.prevClose ?? state.startPrice ?? 0;
        // ordering when deleting: sells first then buys — both high->low (farthest sell first,
        // farthest buy first) so numbering is consistent for user: 1..N (sells) then buys.
        let sorted;
        if (sides.length === 2) {
          const sells = orders
            .filter((o) => o.side === "Sell")
            .slice()
            .sort((a, b) => Number(b.price) - Number(a.price));
          const buys = orders
            .filter((o) => o.side === "Buy")
            .slice()
            .sort((a, b) => Number(b.price) - Number(a.price));
          sorted = sells.concat(buys);
        } else {
          // single-side: present in price descending order for clarity
          sorted = orders
            .slice()
            .sort((a, b) => Number(b.price) - Number(a.price));
        }

        console.log("Wybierz numer(y) z listy zleceń (oddziel przecinkami):");
        sorted.forEach((o, i) => {
          const isPartial = Number(o.partialFilledQty || 0) > 0;
          const displayQty = (isPartial && Number(o.partialRemainingQty || 0) > 0)
            ? Number(o.partialRemainingQty)
            : o.qty;
          const priceStr = isPartial ? `${fmt(o.price, 6)}*` : fmt(o.price, 6);
          console.log(
            `${i + 1}) ${colorSideText(o.side)} @${priceStr} qty=${fmt8(displayQty)} ~${fmt(
              o.price * displayQty,
              6
            )} ${ctx.quote}`
          );
        });

        const numStr = await ask(`numer(y) (1-${sorted.length}) | q=anuluj: `);
        if (isQuit(numStr)) return;
        // accept comma, dot, space, dash etc as separators — normalize to digits list
        const normalized = String(numStr ?? "").replace(/[^\d]+/g, ",");
        const picks = normalized
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
          .map((s) => {
            const n = parseInt(s, 10);
            return Number.isFinite(n) ? n - 1 : null;
          })
          .filter((i) => i !== null && i >= 0 && i < sorted.length);
        if (!picks.length) return;

        for (const idx of picks) {
          const chosen = sorted[idx];
          if (!chosen) {
            console.log(`⚠️ indeks ${idx + 1} poza zakresem`);
            continue;
          }
          if (!chosen.id) {
            // some LIVE provisional orders may not have id yet — try cancelling by linkId if available
            const link = chosen.linkId || null;
            if (link) {
              await actions.exec.cancelOrderById(String(link), "REMOVE_SPECIFIC_LINK");
            } else {
              console.log(`⚠️ nieznany id/link dla zlecenia #${idx + 1}, pomijam`);
            }
            continue;
          }
          await actions.exec.cancelOrderById(String(chosen.id), "REMOVE_SPECIFIC");
        }
        await actions.exec.refreshOpenOrders?.();
        return;
      }

      if (mode === "b") {
        const sideOpt = (await ask(`dodaj: a) buy b) sell c) all | q=anuluj: `)).toLowerCase();
        if (isQuit(sideOpt) || !["a", "b", "c"].includes(sideOpt)) return;

        const priceNow = (state?.prevClose ?? state?.startPrice ?? 0);
        if (!Number.isFinite(priceNow) || priceNow <= 0) {
          console.log("⚠️ Nieznana cena teraz");
          return;
        }

        const pos = (await ask(`lokalizacja: a) bliżej ceny b) dalej ceny | q=anuluj: `)).toLowerCase();
        if (isQuit(pos) || !["a", "b"].includes(pos)) return;

        const sides = [];
        if (sideOpt === "a" || sideOpt === "c") sides.push("Buy");
        if (sideOpt === "b" || sideOpt === "c") sides.push("Sell");

        for (const side of sides) {
          const ords = (state?.openOrders || []).filter((o) => o.side === side);
          let addPrice = priceNow;
          if (ords.length) {
            // compute nearest/farthest relative to the side (not just absolute distance)
            let nearest = ords[0];
            let farthest = ords[ords.length - 1];
            if (side === "Sell") {
              // sells are above priceNow: nearest = lowest sell price, farthest = highest sell price
              const sells = ords.slice().sort((a, b) => Number(a.price) - Number(b.price));
              nearest = sells[0];
              farthest = sells[sells.length - 1];
            } else {
              // buys are below priceNow: nearest = highest buy price, farthest = lowest buy price
              const buys = ords.slice().sort((a, b) => Number(b.price) - Number(a.price));
              nearest = buys[0];
              farthest = buys[buys.length - 1];
            }

            if (pos === "a") {
              // place halfway between priceNow and nearest order (closer to current price)
              addPrice = priceNow + (nearest.price - priceNow) * 0.5;
            } else {
              // place further from priceNow, on the same side — mirror the gap
              if (side === "Sell") {
                const gap = Number(farthest.price) - priceNow;
                addPrice = Number(farthest.price) + gap;
              } else {
                const gap = priceNow - Number(farthest.price);
                addPrice = Number(farthest.price) - gap;
              }
            }
          }

          let baseQty = 0;
          if (state?.grid && Array.isArray(state.grid.orders)) {
            const sideOrders = state.grid.orders.filter((o) => o.side === side);
            if (sideOrders.length) baseQty = sideOrders[0].qty;
          }
          if (!Number.isFinite(baseQty) || baseQty <= 0) {
            baseQty = (CONFIG.ORDER_QUOTE_VALUE ?? 0) / priceNow;
          }

          if (pos === "a" && ords.length) {
            const nearest = ords
              .slice()
              .sort((a, b) => Math.abs(a.price - priceNow) - Math.abs(b.price - priceNow))[0];
            const gapPct = Math.abs((nearest.price - priceNow) / priceNow);
            if (gapPct < (CONFIG.MICRO_SPACING_PCT ?? 0.29)) {
              baseQty /= 2;
            }
          }

          await actions.exec.placeOneExact({ side, price: addPrice, qty: baseQty, info: "ADD_CMD" });
        }

        await actions.exec.refreshOpenOrders?.();
        return;
      }

      if (mode === "c") {
        const pctStr = await ask(`ile % WOLNYCH środków przeznaczyć na rozdział? (0-100) | q=anuluj: `);
        if (isQuit(pctStr)) return;
        const pctBudget = Number(pctStr);
        if (!Number.isFinite(pctBudget) || pctBudget < 0 || pctBudget > 100) {
          console.log(`⚠️ Podaj liczbę 0-100`);
          return;
        }

        const side = (await ask(`WOLNE rozdziel: a) buy(quote) b) sell(base) c) all | q=anuluj: `)).toLowerCase();
        if (isQuit(side) || !["a", "b", "c"].includes(side)) return;

        const bias = (await ask(`tryb: a) równo b) bliżej ceny c) dalej ceny | q=anuluj: `)).toLowerCase();
        if (isQuit(bias) || !["a", "b", "c"].includes(bias)) return;

        if (bias === "a") {
          // równomierny podział, nic dodatkowego nie pytamy
          try {
          await actions.redistribute({ sideSel: side, mode: "equal", pctBudget });
        } catch (e) {
          console.log(`⚠️ redistribute command failed: ${e?.message || e}`);
        }
          return;
        }

        const lin = (await ask(`rozkład: a) linearnie b) geometrycznie(x^2) | q=anuluj: `)).toLowerCase();
        if (isQuit(lin) || !["a", "b"].includes(lin)) return;

        // ask percent for special order depending on bias text
        let pctNearest = null;
        let pctPrompt = "ile % środków ma być przy zleceniu najbliżej ceny? (0-100) | q=anuluj: ";
        if (bias === "c") {
          pctPrompt = "ile % środków ma być przy zleceniu najdalej od ceny? (0-100) | q=anuluj: ";
        }
        const pctNearestStr2 = await ask(pctPrompt);
        if (isQuit(pctNearestStr2)) return;
        if (pctNearestStr2.trim() !== "") {
          const tmp = Number(pctNearestStr2);
          if (!Number.isFinite(tmp) || tmp < 0 || tmp > 100) {
            console.log(`⚠️ Podaj wartość 0-100`);
            return;
          }
          pctNearest = tmp;
        }

        if (lin === "a") {
          try {
            await actions.redistribute({
              sideSel: side,
              mode: bias === "b" ? "closer-linear" : "farther-linear",
              pctBudget,
              pctNearest,
            });
          } catch (e) {
            console.log(`⚠️ redistribute command failed: ${e?.message || e}`);
          }
          return;
        }

        // geometryczny tryb, wykorzystujemy tę samą wartość pctNearest
        try {
          await actions.redistribute({
            sideSel: side,
            mode: bias === "b" ? "closer-quadratic" : "farther-quadratic",
            pctNearest,
            pctBudget,
          });
        } catch (e) {
          console.log(`⚠️ redistribute command failed: ${e?.message || e}`);
        }
        return;
      }
    }
  }

  async function dialogTestMode() {
    if (!actions.isTestMode?.()) {
      console.log(`⚠️ Komenda t działa tylko w trybie PAPER="TEST"`);
      return;
    }

    while (true) {
      const mode = (await ask(`TEST(t): a) przesun czas b) zmien cene c) program | q=anuluj: `)).toLowerCase();
      if (isQuit(mode)) return;

      if (mode === "a") {
        const secStr = await ask(`o ile sekund przesunac czas? (np 60 / 3600) | q=anuluj: `);
        if (isQuit(secStr)) return;
        const sec = Number(secStr);
        if (!Number.isFinite(sec)) return;
        await actions.testShiftTime?.(sec);
        return;
      }

      if (mode === "b") {
        const deltaStr = await ask(`zmiana ceny: % albo nominalnie (np +0.2% / -0.2% / +10 / -150) | q=anuluj: `);
        if (isQuit(deltaStr)) return;
        await actions.testChangePrice?.(deltaStr);
        return;
      }

      if (mode === "c") {
        const list = await actions.testListScenarios?.();
        if (list?.length) console.log(`📚 scenariusze: ${list.join(", ")}`);
        else console.log(`📚 scenariusze: (brak plików w folderze scenario)`);

        const pick = await ask(`podaj nazwę scenariusza (bez .json) | q=anuluj: `);
        if (isQuit(pick)) return;
        await actions.testRunScenario?.(pick);
        return;
      }
    }
  }

  rl.on("line", async (line) => {
    const raw = (line || "").trim().toLowerCase();
    if (!raw) {
      rl.prompt();
      return;
    }

    const parts = raw.split(/\s+/).filter(Boolean);
    const cmd = parts[0] || "";
    const arg = parts[1] || "";

    if (cmd === "o" || cmd === "orders") {
      await actions.printOrders?.();
      rl.prompt();
      return;
    }
    if (cmd === "r" || cmd === "regrid") {
      await dialogRegridFull();
      rl.prompt();
      return;
    }
    if (cmd === "r2") {
      await dialogRegridPartial();
      rl.prompt();
      return;
    }
    if (cmd === "c" || cmd === "clear") {
      await dialogClear();
      rl.prompt();
      return;
    }
    if (cmd === "m" || cmd === "move") {
      await dialogMove();
      rl.prompt();
      return;
    }
    if (cmd === "g" || cmd === "grid") {
      await dialogGridSettings();
      rl.prompt();
      return;
    }
    if (cmd === "z") {
      await dialogRedistribute();
      rl.prompt();
      return;
    }
    if (cmd === "p" || cmd === "power") {
      await dialogPowerKeepAwake(arg);
      rl.prompt();
      return;
    }
    if (cmd === "t" || cmd === "test") {
      await dialogTestMode();
      rl.prompt();
      return;
    }
    if (cmd === "q" || cmd === "quit" || cmd === "exit") {
      process.exit(0);
    }

    printCommands();
    rl.prompt();
  });

  printCommands();
  rl.prompt();

  // now that everything is wired up we can return the helpers
  return { ask, rl, isQuit };
}
