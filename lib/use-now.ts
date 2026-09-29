"use client";

import { useEffect, useState } from "react";

/**
 * The current time for "12s ago" labels, ticking once a second.
 *
 * Starts at the server's render time, so the first client render prints the
 * same ages the server did. Reading the clock during render instead made every
 * age differ by the second or two the page took to arrive, which React treats
 * as a hydration failure and answers by re-rendering the whole list.
 */
export function useNow(serverNow: number): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
