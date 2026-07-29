import * as React from "react";
import { resolveUri } from "@/lib/uri";

/** FlexLayout tab 的内容：一个装载块 URI 的 iframe。 */
export const BlockFrame = React.memo(function BlockFrame({
  wid,
  tabId,
  uri,
}: {
  wid: string;
  tabId: string;
  uri: string | null;
}) {
  const src = resolveUri(uri, wid, tabId);
  return (
    <iframe
      src={src}
      title={uri ?? "launcher"}
      className="h-full w-full border-0 bg-background"
    />
  );
});
