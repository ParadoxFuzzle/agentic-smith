import type { ListSearchOptions } from "@agentic-smith/core";
import { listSearch } from "@agentic-smith/core";
import { useState } from "react";

export function useListSearch<T>(items: readonly T[], options: ListSearchOptions<T>) {
  const [query, setQuery] = useState("");
  return { query, setQuery, ...listSearch(items, query, options) };
}
