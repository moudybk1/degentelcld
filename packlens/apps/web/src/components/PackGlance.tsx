import type { ReactNode } from "react";
import { CaretRight, Info, Question, WarningCircle } from "@phosphor-icons/react";
import type { PackDetail } from "@packlens/contracts";
import { usd } from "../lib/format";
import { duration, type FactTone } from "../lib/packFacts";
import { signed } from "./AfterChart";

/**
 * The guide's "questions before you act", answered for this pack from its own
 * facts. Each answer names what happened and links to the evidence; none says
 * what the price will do or whether to trade.
 */

type Answer = { q: string; a: string; detail: ReactNode; tone: FactTone; section: string };

function answers(d: PackDetail): Answer[] {
  const out: Answer[] = [];
  const after = d.after;
  const m = after.members;
  const trades = after.activity.buys + after.activity.sells;

  // 1. Timing: how early, and how tight.
  const created = after.tokenCreatedAt ? Date.parse(after.tokenCreatedAt) : null;
  const age = created === null ? null : d.core.firstEventTimeMs - created;
  const span = d.patterns.initialEntrySpanMs;
  const tight = span === 0 ? "The first wallets bought in the same second." : `The first ${d.core.initialWalletCount} wallets bought within ${duration(span)}.`;
  out.push(
    age === null || age < 0
      ? { q: "How early did they buy?", a: "Launch time not observed", detail: `The token's creation was not seen by the collector. ${tight}`, tone: "unknown", section: "sec-formation" }
      : {
          q: "How early did they buy?",
          a: age < 1000 ? "At launch" : `${duration(age)} after launch`,
          detail: `${age < 1000 ? "The first pack buy came in the same second the token was created." : `The token was created ${duration(age)} before the first pack buy.`} ${tight}`,
          tone: age <= 10_000 || span === 0 ? "attention" : "neutral",
          section: "sec-formation",
        },
  );

  // 2. One actor or many.
  const largest = d.patterns.largestBuyerShare === null ? null : Number(d.patterns.largestBuyerShare);
  const cv = d.patterns.buySizeCV === null ? null : Number(d.patterns.buySizeCV);
  if (largest !== null && largest >= 0.5) {
    out.push({ q: "A real group, or one buyer?", a: "Mostly one buyer", detail: `One wallet made ${Math.round(largest * 100)}% of the pack's ${usd(d.core.eligibleBuyUsd)} of buying.`, tone: "attention", section: "sec-patterns" });
  } else if (cv !== null && cv < 0.15 && d.patterns.memberCount >= 3) {
    out.push({ q: "A real group, or one buyer?", a: "Nearly identical buys", detail: `Buy sizes barely differ (variation ${cv.toFixed(2)}). Uniform sizing can mean one operator or a script.`, tone: "attention", section: "sec-patterns" });
  } else {
    out.push({
      q: "A real group, or one buyer?",
      a: `Spread over ${d.core.totalWalletCount} wallets`,
      detail: `${usd(d.core.eligibleBuyUsd)} of buying; the largest wallet made ${largest === null ? "an unknown share" : `${Math.round(largest * 100)}%`}. Separate wallets can still share an owner.`,
      tone: "neutral",
      section: "sec-patterns",
    });
  }

  // 3. Still holding?
  if (m.sold === 0) {
    out.push({ q: "Are the pack wallets still holding?", a: "None have sold", detail: `0 of ${m.count} pack wallets sold in the observed trades.`, tone: "neutral", section: "sec-after" });
  } else {
    const share = m.soldShare === null ? null : Math.round(m.soldShare * 100);
    const first = m.firstSellAt ? ` First sale ${duration(Date.parse(m.firstSellAt) - d.core.firstEventTimeMs)} after the first pack buy.` : "";
    out.push({
      q: "Are the pack wallets still holding?",
      a: m.sold >= m.count ? `All ${m.count} have sold` : `${m.sold} of ${m.count} have sold`,
      detail: `${share === null ? "" : `${share}% of the tokens they bought is sold.`}${first}`,
      tone: m.sold >= m.count || (share ?? 0) >= 50 ? "attention" : "neutral",
      section: "sec-after",
    });
  }

  // 4. Price since the pack, and whether buying continued.
  if (trades === 0 || after.lastChangePct === null) {
    out.push({ q: "Has the price moved since?", a: "No trades since", detail: "No trades of this token have been observed since the pack formed.", tone: "neutral", section: "sec-after" });
  } else {
    const net = Number(after.activity.netSol);
    const peak = after.peak ? ` Peak ${signed(after.peak.changePct)} after ${duration(Date.parse(after.peak.at) - d.core.triggerEventTimeMs)}.` : "";
    out.push({
      q: "Has the price moved since?",
      a: `${signed(after.lastChangePct)} vs their entry`,
      detail: (
        <>
          Latest trade against the pack's average entry price.{peak} Since then {after.activity.buys} buys and {after.activity.sells} sells, net {Math.abs(net).toFixed(2)} SOL {net >= 0 ? "bought" : "sold"}.
          {after.graduatedAt ? " The token has left the bonding curve, so later trades are not observed." : ""}
        </>
      ),
      tone: Math.abs(after.lastChangePct) >= 50 || (after.peak?.changePct ?? 0) >= 100 ? "attention" : "neutral",
      section: "sec-after",
    });
  }

  // 5. History of the same wallets.
  const earlier = d.earlierPacks;
  if (earlier.length === 0) {
    out.push({ q: "Has this group done it before?", a: "Not in the observed data", detail: "No earlier pack shares two or more of these wallets.", tone: "neutral", section: "sec-earlier" });
  } else {
    const known = earlier.filter((e) => e.changePct15m !== null);
    const up = known.filter((e) => (e.changePct15m ?? 0) > 0).length;
    out.push({
      q: "Has this group done it before?",
      a: `Yes, ${earlier.length >= 10 ? "10+" : earlier.length} earlier ${earlier.length === 1 ? "pack" : "packs"}`,
      detail: known.length > 0 ? `15 minutes after those packs, ${up} of ${known.length} tokens were above the pack's entry. History, not a forecast.` : "What happened in the 15 minutes after them was not observed.",
      tone: "attention",
      section: "sec-earlier",
    });
  }

  // 6. Smart Money: in the pack, or only near the token.
  const confirmed = d.smartMoney.packConfirmation.confirmedMemberCount;
  const hour = d.smartMoney.windows[1];
  const buyers = hour && hour.countQualifier !== "unknown" ? hour.observedUniqueBuyers : null;
  if (confirmed === null && buyers === null) {
    out.push({ q: "Is Smart Money involved?", a: "Not checked yet", detail: "Nansen Smart Money data has not been fetched for this pack. Unknown, not zero.", tone: "unknown", section: "sec-sm" });
  } else if (confirmed !== null && confirmed > 0) {
    out.push({ q: "Is Smart Money involved?", a: `${confirmed} of ${d.core.totalWalletCount} pack wallets`, detail: "Their own pack buys appear in Nansen's Smart Money data.", tone: "attention", section: "sec-sm" });
  } else if (buyers !== null && buyers > 0) {
    out.push({
      q: "Is Smart Money involved?",
      a: "Near the token, not in the pack",
      detail: `${hour!.countQualifier === "at_least" ? "At least " : ""}${buyers} Smart Money ${buyers === 1 ? "wallet" : "wallets"} bought this token in the past hour; ${confirmed === null ? "pack wallets were not checked" : "none matched a pack buy"}.`,
      tone: "neutral",
      section: "sec-sm",
    });
  } else {
    out.push({ q: "Is Smart Money involved?", a: "None observed", detail: `No Smart Money buyers in the checked data for the past hour${confirmed === 0 ? ", and no pack wallet was confirmed" : ""}. Not checked is different from none.`, tone: "neutral", section: "sec-sm" });
  }
  return out;
}

export function PackGlance({ detail }: { detail: PackDetail }) {
  if (!detail.after) return null;
  return (
    <div className="glance">
      {answers(detail).map((x) => (
        <a key={x.q} className={`glance-card ${x.tone}`} href={`#${x.section}`}>
          <span className="glance-q">
            {x.tone === "attention" ? (
              <WarningCircle size={14} weight="bold" aria-hidden="true" />
            ) : x.tone === "unknown" ? (
              <Question size={14} weight="bold" aria-hidden="true" />
            ) : (
              <Info size={14} weight="bold" aria-hidden="true" />
            )}
            {x.q}
          </span>
          <span className="glance-a">{x.a}</span>
          <span className="glance-detail">{x.detail}</span>
          <span className="glance-more">
            See the evidence <CaretRight size={11} weight="bold" aria-hidden="true" />
          </span>
          {x.tone === "attention" && <span className="sr-only">Worth a closer look.</span>}
        </a>
      ))}
    </div>
  );
}
