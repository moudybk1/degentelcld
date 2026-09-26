import { Link } from "react-router";
import { ChartLineUp, Receipt, UsersThree, X } from "@phosphor-icons/react";
import { useNsHref } from "../state/namespace";
import { ruleUsd, useRule } from "../lib/rule";

/**
 * What a pack is, in three steps, and what it can and cannot tell you. Shown
 * on the radar until dismissed; the header's "How it works" button brings it back.
 */
export function HowItWorks({ onDismiss }: { onDismiss: () => void }) {
  const href = useNsHref();
  const rule = useRule();
  return (
    <section className="how" aria-labelledby="how-title">
      <header className="how-head">
        <h2 id="how-title" className="h3">
          How Pack Radar works
        </h2>
        <button type="button" className="icon-btn" aria-label="Hide this guide suggestion" onClick={onDismiss}>
          <X size={14} weight="bold" />
        </button>
      </header>
      <ol className="how-steps">
        <li>
          <span className="how-icon" aria-hidden="true">
            <UsersThree size={20} weight="bold" />
          </span>
          <strong>Wallets buy together</strong>
          <span>
            A <em>pack</em> forms when {rule.minUniqueWallets} or more different wallets each buy at least {ruleUsd(rule)} of the same pump.fun token within {rule.triggerWindowSeconds} seconds.
            Wallets that buy in the next {rule.expansionSeconds} seconds join it.{rule.isBaseline ? "" : " This site runs a custom rule; the spec baseline is 3 wallets and $20."}
          </span>
        </li>
        <li>
          <span className="how-icon" aria-hidden="true">
            <Receipt size={20} weight="bold" />
          </span>
          <strong>Every buy is kept as evidence</strong>
          <span>Each pack stores the transactions that formed it, so you can check who bought, when, how much, and open each one on Solscan.</span>
        </li>
        <li>
          <span className="how-icon" aria-hidden="true">
            <ChartLineUp size={20} weight="bold" />
          </span>
          <strong>Then we watch what happens</strong>
          <span>The price is compared with what the group paid, and we track whether the group's own wallets have sold.</span>
        </li>
      </ol>
      <p className="how-foot">
        <strong>What a pack can mean:</strong> a coordinated group or one person with several wallets, bots reacting to the same launch, or coincidence on a busy token. Many packs start within seconds of a token's launch. A pack is a lead to
        check, not a buy signal. <Link className="text-link" to={href("/guide")}>Read the short guide</Link>
      </p>
    </section>
  );
}
