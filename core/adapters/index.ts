import { ArmConfig, FetchResult, Provider } from "../types";
import { fetchBrightData } from "./brightdata";
import { fetchFirecrawl } from "./firecrawl";

// The whole trick: one identical interface for every provider.
export function fetchSources(
  provider: Provider,
  query: string,
  config: ArmConfig,
): Promise<FetchResult> {
  switch (provider) {
    case "bright_data":
      return fetchBrightData(query, config);
    case "firecrawl":
      return fetchFirecrawl(query, config);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
