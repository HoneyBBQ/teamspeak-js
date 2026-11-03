/**
 * The value tables that restrict an input, as a compile-time rule checked by
 * `pnpm typecheck`.
 *
 * Nothing here runs: vitest collects `src/**\/*.test.ts`, and this file is not
 * one of them. Each deliberately wrong case carries `@ts-expect-error`, which
 * fails the build as soon as that case starts compiling.
 */
import {
  BannerMode,
  BindingSubsystem,
  CodecEncryptionMode,
  PermissionName,
  PropertyName,
  editInstance,
  editServer,
  getPermissionIDByName,
  isValueOf,
} from "./index.js";
import type { BindingListOptions } from "./api/server.js";
import type { ChannelSettings } from "./api/channels.js";
import type { CommandExecutor } from "./command/request.js";

declare function takesChannel(settings: ChannelSettings): void;
declare function takesBindings(options: BindingListOptions): void;
declare const client: CommandExecutor;

takesChannel({ bannerMode: BannerMode.AdjustKeepAspect });
takesChannel({ bannerMode: 2 });
// @ts-expect-error the server refuses a banner mode outside 0-2
takesChannel({ bannerMode: 3 });

takesBindings({ subsystem: BindingSubsystem.Query });
takesBindings({ subsystem: "filetransfer" });
// @ts-expect-error the server refuses a subsystem it does not have
takesBindings({ subsystem: "bogus" });

// A value read back from storage is a plain number or string, and isValueOf
// narrows it to what the parameter takes.
declare const stored: number;
// @ts-expect-error a plain number is not yet a banner mode
takesChannel({ bannerMode: stored });
if (isValueOf(BannerMode, stored)) takesChannel({ bannerMode: stored });
declare const storedSubsystem: string;
if (isValueOf(BindingSubsystem, storedSubsystem)) takesBindings({ subsystem: storedSubsystem });

// Raw settings take what getServerInfo answers, the tables' constants, any key
// the table does not name, and nothing that is not a primitive.
declare const info: Readonly<Record<string, string>>;
void editServer(client, info);
void editServer(client, {
  [PropertyName.VirtualServerHostBannerMode]: BannerMode.AdjustKeepAspect,
  [PropertyName.VirtualServerCodecEncryptionMode]: CodecEncryptionMode.ForcedOn,
  virtualserver_weblist_enabled: false,
  virtualserver_some_newer_property: "1",
});
void editInstance(client, { [PropertyName.ServerInstanceServerQueryFloodCommands]: 50 });
// @ts-expect-error an object is not a property value
void editServer(client, { virtualserver_name: { text: "x" } });

// A permission name is offered from the table, and any other name is taken.
void getPermissionIDByName(client, PermissionName.VirtualServerInfoView);
void getPermissionIDByName(client, "i_some_newer_permission");
