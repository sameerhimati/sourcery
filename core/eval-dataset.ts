// Curated eval dataset for the retrieval-eval harness.
//
// These are retrieval-dependent queries: answering them correctly requires
// fresh, post-cutoff information. The judge model (gpt-4o-mini) has an
// Oct-2023 knowledge cutoff, while the app's reference date is 2026-07-07 —
// so a model relying on parametric memory alone will be stale or wrong, and
// only genuine retrieval can score well.
//
// Every query is deliberately phrased with "latest / current / newest / today"
// framing (rather than pinned to a specific version, date, or figure) so the
// dataset does not go stale as the world moves on.
//
// 6 types x 8 queries = 48 total.

export type QueryType =
  | "breaking_news"
  | "how_to"
  | "product_lookup"
  | "local_geo"
  | "recent_release"
  | "numeric_live";

/**
 * Whether a question has one right answer or several defensible ones.
 *
 * `sharp` — a number, a date, a version, a named thing. Two careful people
 * looking at the same page would agree on whether it answers the question.
 * `open` — real work where several different pages could each genuinely be the
 * best result.
 *
 * It exists because judges are expected to agree less on open questions, and
 * that is a claim the run should be able to check rather than assume. Optional,
 * and absent from the 48 below: they were written before the distinction, and
 * they are frozen.
 */
export type Sharpness = "sharp" | "open";

/**
 * What the question is *about*, as opposed to what shape it takes.
 *
 * `QueryType` above is the shape of the task — look something up, follow a
 * how-to, find a live number. Genre is the subject it happens to be about, and
 * the two are independent: "what did this library change in its last release"
 * and "what did this club change in its last transfer window" are the same
 * shape and different worlds.
 *
 * It exists because the question set leans toward developer infrastructure, and
 * an untagged lean can only be apologised for in a limitations section. Tagged,
 * it becomes the more useful question: does the ranking hold outside software?
 * If a provider leads on software questions and trails on sports ones, that is
 * the strongest evidence there is for publishing a map of specialities rather
 * than a league table.
 */
export type Genre =
  | "software" // dev tools, infrastructure, APIs, library releases
  | "business" // pricing, companies, markets, finance
  | "science" // research, medicine, climate, energy
  | "sports" // results, records, transfers, fixtures
  | "policy" // regulation, government, courts
  | "everyday"; // travel, local, consumer goods, culture

export interface EvalQuery {
  id: string;
  type: QueryType;
  query: string;
  note?: string; // author-only, NOT sent to the judge
  sharpness?: Sharpness; // author-only, NOT sent to the judge
  genre?: Genre; // author-only, NOT sent to the judge
}

export const EVAL_DATASET: EvalQuery[] = [
  // breaking_news
  {
    id: "bn-01",
    type: "breaking_news",
    query:
      "What is the latest major development in the ongoing Russia-Ukraine war?",
  },
  {
    id: "bn-02",
    type: "breaking_news",
    query:
      "What are the most recent headlines on the Israel-Hamas/Gaza ceasefire situation?",
  },
  {
    id: "bn-03",
    type: "breaking_news",
    query:
      "What is the current status of the US Federal Reserve's interest rate policy this month?",
  },
  {
    id: "bn-04",
    type: "breaking_news",
    query:
      "What is the newest major announcement from OpenAI in the past two weeks?",
  },
  {
    id: "bn-05",
    type: "breaking_news",
    query: "What is the latest development in current US tariff policy?",
  },
  {
    id: "bn-06",
    type: "breaking_news",
    query:
      "What happened in the most recent significant natural disaster (earthquake, hurricane, wildfire) this month?",
  },
  {
    id: "bn-07",
    type: "breaking_news",
    query: "What are the newest developments in Taiwan-China tensions?",
  },
  {
    id: "bn-08",
    type: "breaking_news",
    query:
      "What is the most recent major interest-rate decision from a central bank (Fed, ECB, or BOE)?",
  },

  // how_to
  {
    id: "ht-01",
    type: "how_to",
    query:
      "How do I enable two-factor authentication on Instagram from the app?",
  },
  {
    id: "ht-02",
    type: "how_to",
    query: "How do I turn off Meta AI inside WhatsApp?",
  },
  {
    id: "ht-03",
    type: "how_to",
    query: "How do I set up Apple Intelligence writing tools on an iPhone?",
  },
  {
    id: "ht-04",
    type: "how_to",
    query: "How do I connect Claude Code to a custom MCP server?",
  },
  {
    id: "ht-05",
    type: "how_to",
    query:
      "How do I enable ChatGPT's memory feature and see what it has stored about me?",
  },
  {
    id: "ht-06",
    type: "how_to",
    query:
      'How do I switch X (Twitter) from the algorithmic timeline to the "Following" feed by default?',
  },
  {
    id: "ht-07",
    type: "how_to",
    query: "How do I set up passkeys for my Google account?",
  },
  {
    id: "ht-08",
    type: "how_to",
    query:
      "How do I configure GitHub Actions to use OIDC instead of a stored secret for AWS deployment?",
  },

  // product_lookup
  {
    id: "pl-01",
    type: "product_lookup",
    query:
      "What is the current price and storage configurations for the newest iPhone model?",
  },
  {
    id: "pl-02",
    type: "product_lookup",
    query:
      "Is the PlayStation 5 Pro currently in stock at major US retailers, and at what price?",
  },
  {
    id: "pl-03",
    type: "product_lookup",
    query: "What is the current retail price of an NVIDIA GeForce RTX 5090?",
  },
  {
    id: "pl-04",
    type: "product_lookup",
    query: "What are the specs and starting price of the newest MacBook Pro?",
  },
  {
    id: "pl-05",
    type: "product_lookup",
    query:
      "What is the current starting price of a Tesla Model Y in the United States?",
  },
  {
    id: "pl-06",
    type: "product_lookup",
    query:
      "What is the lowest current price for AirPods Pro across major retailers?",
  },
  {
    id: "pl-07",
    type: "product_lookup",
    query:
      "What is the release price and availability of the newest Samsung Galaxy S-series flagship?",
  },
  {
    id: "pl-08",
    type: "product_lookup",
    query:
      "What is the current price and availability of the Nintendo Switch 2?",
  },

  // local_geo
  {
    id: "loc-01",
    type: "local_geo",
    query:
      "What are today's opening hours for the Apple Store on Michigan Avenue in Chicago?",
  },
  {
    id: "loc-02",
    type: "local_geo",
    query:
      "What is the current wait time at the DMV office in downtown Austin, Texas?",
  },
  {
    id: "loc-03",
    type: "local_geo",
    query:
      "What are the best-rated brunch restaurants currently open near Union Square, San Francisco?",
  },
  {
    id: "loc-04",
    type: "local_geo",
    query:
      "What is the current open/closed status of In-N-Out Burger locations in Seattle, Washington?",
  },
  {
    id: "loc-05",
    type: "local_geo",
    query:
      "What are this week's hours of operation for the New York Public Library main branch?",
  },
  {
    id: "loc-06",
    type: "local_geo",
    query:
      "Are there current road closures or construction on I-95 near Miami, Florida?",
  },
  {
    id: "loc-07",
    type: "local_geo",
    query:
      "What are the current gas prices at stations near downtown Portland, Oregon?",
  },
  {
    id: "loc-08",
    type: "local_geo",
    query:
      "What is the current status of Washington DC Metro service (delays/closures) today?",
  },

  // recent_release
  {
    id: "rr-01",
    type: "recent_release",
    query:
      "What is the latest stable version of Python, and what are its new features?",
  },
  {
    id: "rr-02",
    type: "recent_release",
    query:
      "What is the most recent Claude model released by Anthropic, and what are its key capabilities?",
  },
  {
    id: "rr-03",
    type: "recent_release",
    query: "What are the newest features in the latest Node.js LTS release?",
  },
  {
    id: "rr-04",
    type: "recent_release",
    query:
      "What is the latest version of the Model Context Protocol (MCP) specification?",
  },
  {
    id: "rr-05",
    type: "recent_release",
    query:
      "What are the release notes for the newest stable version of Kubernetes?",
  },
  {
    id: "rr-06",
    type: "recent_release",
    query:
      "What is the latest flagship model released by OpenAI, and what changed?",
  },
  {
    id: "rr-07",
    type: "recent_release",
    query:
      "What is the newest major version of React, and what changed from the previous major version?",
  },
  {
    id: "rr-08",
    type: "recent_release",
    query:
      "What is the most recent iOS version released by Apple, and what are its headline features?",
  },

  // numeric_live
  {
    id: "nl-01",
    type: "numeric_live",
    query: "What is the current stock price of NVIDIA (NVDA)?",
  },
  {
    id: "nl-02",
    type: "numeric_live",
    query: "What is the current USD/EUR exchange rate?",
  },
  {
    id: "nl-03",
    type: "numeric_live",
    query:
      "What is the current Federal Funds interest rate set by the Federal Reserve?",
  },
  {
    id: "nl-04",
    type: "numeric_live",
    query:
      "What are the current standings in the English Premier League this season?",
  },
  {
    id: "nl-05",
    type: "numeric_live",
    query:
      "What is the current US national average price for a gallon of regular gasoline?",
  },
  {
    id: "nl-06",
    type: "numeric_live",
    query:
      "What is the current average 30-year fixed mortgage rate in the US?",
  },
  {
    id: "nl-07",
    type: "numeric_live",
    query:
      "What is today's weather forecast and temperature for Denver, Colorado?",
  },
  {
    id: "nl-08",
    type: "numeric_live",
    query:
      "What is the most recent US unemployment rate from the latest jobs report?",
  },
];
