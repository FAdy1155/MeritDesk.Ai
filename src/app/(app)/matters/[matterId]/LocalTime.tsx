"use client";

import { useSyncExternalStore } from "react";

// A timestamp in the viewer's own time zone. The server does not know that
// zone, so the server render (and the hydration pass that must match it)
// prints UTC, and the browser then switches to local time. Same pattern as
// any client-only value: useSyncExternalStore with a server snapshot.

const UTC_FORMAT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

let localFormat: Intl.DateTimeFormat | null = null;
function formatLocal(date: Date): string {
  localFormat ??= new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  return localFormat.format(date);
}

const subscribe = () => () => {};

export function LocalTime({ value }: { value: Date | string }) {
  const inBrowser = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time dateTime={date.toISOString()} title={`${UTC_FORMAT.format(date)} UTC`}>
      {inBrowser ? formatLocal(date) : `${UTC_FORMAT.format(date)} UTC`}
    </time>
  );
}
