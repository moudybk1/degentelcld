# Demo script (about 55 seconds)

Prepare: start a live session (`npm run session:set -- 1h`, `npm run build`, `APP_MODE=live npm run start`), wait until packs are analyzed, and pin the chosen token from its pack page. For a reproducible demo, export the window (`npm run dataset:export`) and replay it; the Replay badge and original times stay visible. If no pack member is confirmed as Smart Money, show that honestly.

| Time | Screen and action | Narration |
|---|---|---|
| 0–6 s | Pack Radar; point at the **Live** badge, *Connected*, and the latest trigger | "PackLens finds wallets buying the same Solana token almost simultaneously." |
| 6–15 s | Open a pack card | "Here, several wallets made eligible buys of the same pump.fun token within twenty seconds." |
| 15–25 s | Timeline, member table, evidence rows with Solscan links and price provenance | "Every pack has transaction evidence: each member, each buy, and the price used to value it." |
| 25–38 s | Smart Money on this token: the 5-minute, 1-hour, 24-hour buyers and *Confirmed pack members* | "Nansen adds Smart Money buyer counts across several windows. Those are separate from confirmed pack members, and partial data is clearly labeled." |
| 38–48 s | Wallet and token context: PnL, relationships, holders | "Wallet and token context from Nansen supports the investigation. A relationship is a lead, not proof of common ownership." |
| 48–55 s | Coverage and history; Operator usage | "Coverage and sources are explicit. Pack detection stays unchanged; Smart Money only adds context." |

Narration (full):

> PackLens finds wallets buying the same Solana token almost simultaneously. Every pack has transaction evidence. Nansen adds wallet and token context, including Smart Money buyer counts across several time windows. Those counts are separate from confirmed pack members, and partial data is clearly labeled. Pack detection stays unchanged; Smart Money provides additional context for the user.

Backup: if the live source is quiet or disconnected, use a replay of a recorded dataset (its original date and the Replay badge stay visible). If Nansen is unavailable, stored snapshots remain readable with their fetch times.
