import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Send } from "lucide-react";
import {
  ActionRow,
  BottomSheet,
  SectionRow,
  SectionRows,
  SkeletonBlock,
  Spinner,
} from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  connectTelegramBotFn,
  disconnectChannelFn,
  listChannelConnectionsFn,
} from "@/api/channels";
import { useCapabilities } from "@/hooks/use-capabilities";
import { notifyError, notifySuccess } from "@/lib/feedback";
import { fullTimestamp } from "@/lib/format";
import {
  channelKeys,
  classifyConnectError,
  looksLikeTelegramToken,
  type ConnectErrorKind,
} from "@/lib/channels-view";
import { sameScope, type OperationScope } from "@/lib/conversation/reply-session";

interface TelegramChannelRowProps {
  userId: string;
  organizationId: string;
}

/**
 * Settings → Channels → Telegram.
 *
 * The merchant creates a bot with @BotFather and pastes its token here once.
 * The server validates it with Telegram, encrypts it and points the bot's
 * webhook at APSA; the token is never shown again and never returned. Every
 * gate here is a courtesy: listChannelConnections, connectTelegramBot and
 * disconnectChannel check integrations.* themselves.
 */
export function TelegramChannelRow({ userId, organizationId }: TelegramChannelRowProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const canRead = capabilities.can("integrations.read");
  const canConnect = capabilities.can("integrations.connect");
  const canDisconnect = capabilities.can("integrations.disconnect");

  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<ConnectErrorKind | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  /*
   * Every connect/disconnect carries the member + organization it was started
   * as (the server refuses it if the session changed), and applies its result
   * — the form, the toast, the cache — only if this row still shows that same
   * principal and no newer operation started (sameScope).
   */
  const operationRef = useRef(0);
  const scopeRef = useRef<OperationScope>({
    userId,
    organizationId,
    conversationId: "",
    operation: 0,
  });
  scopeRef.current = {
    userId,
    organizationId,
    conversationId: "",
    operation: operationRef.current,
  };
  function beginOperation(): OperationScope {
    operationRef.current += 1;
    scopeRef.current = { ...scopeRef.current, operation: operationRef.current };
    return scopeRef.current;
  }

  // A principal switch abandons whatever this row was doing for the old one.
  useEffect(() => {
    operationRef.current += 1;
    setOpen(false);
    setToken("");
    setConnecting(false);
    setConnectError(null);
    setConfirmDisconnect(false);
    setDisconnecting(false);
  }, [userId, organizationId]);

  const queryKey = channelKeys.list(userId, organizationId);
  const query = useQuery({
    queryKey,
    queryFn: () => listChannelConnectionsFn(),
    enabled: canRead,
    retry: false,
  });

  if (!canRead) return null;

  const telegram = query.data?.find((connection) => connection.provider === "TELEGRAM");
  const handle = telegram?.handle ? `@${telegram.handle}` : (telegram?.displayName ?? "");

  async function connect() {
    if (connecting) return;
    if (!looksLikeTelegramToken(token)) {
      setConnectError("invalid_token");
      return;
    }
    const started = beginOperation();
    setConnecting(true);
    setConnectError(null);
    try {
      await connectTelegramBotFn({
        data: {
          token: token.trim(),
          expectedPrincipal: { userId: started.userId, organizationId: started.organizationId },
        },
      });
      if (!sameScope(started, scopeRef.current)) return;
      setToken("");
      await queryClient.invalidateQueries({
        queryKey: channelKeys.list(started.userId, started.organizationId),
      });
      if (!sameScope(started, scopeRef.current)) return;
      notifySuccess(t("settings.channels.telegram.connected"));
    } catch (error) {
      if (!sameScope(started, scopeRef.current)) return;
      setConnectError(classifyConnectError(error));
      // A refused or superseded connect may still have changed the row.
      void queryClient.invalidateQueries({
        queryKey: channelKeys.list(started.userId, started.organizationId),
      });
    } finally {
      if (sameScope(started, scopeRef.current)) setConnecting(false);
    }
  }

  async function disconnect() {
    if (!telegram || disconnecting) return;
    const started = beginOperation();
    setDisconnecting(true);
    try {
      await disconnectChannelFn({
        data: {
          connectionId: telegram.id,
          expectedPrincipal: { userId: started.userId, organizationId: started.organizationId },
        },
      });
      if (!sameScope(started, scopeRef.current)) return;
      setConfirmDisconnect(false);
      await queryClient.invalidateQueries({
        queryKey: channelKeys.list(started.userId, started.organizationId),
      });
      if (!sameScope(started, scopeRef.current)) return;
      notifySuccess(t("settings.channels.telegram.disconnected"));
    } catch (error) {
      if (!sameScope(started, scopeRef.current)) return;
      // Another change to this bot (or one whose outcome Telegram never
      // confirmed) is still settling: say so rather than "try again".
      notifyError(
        t(
          classifyConnectError(error) === "connect_in_progress"
            ? "settings.channels.telegram.connectError.connect_in_progress"
            : "settings.channels.telegram.disconnectError",
        ),
      );
    } finally {
      if (sameScope(started, scopeRef.current)) setDisconnecting(false);
    }
  }

  const description = query.isPending
    ? undefined
    : query.isError
      ? t("settings.channels.telegram.unavailable")
      : telegram
        ? t("settings.channels.telegram.connectedAs", { handle })
        : t("settings.channels.telegram.notConnected");

  return (
    <>
      <ActionRow
        icon={Send}
        label={t("settings.channels.telegram.label")}
        description={description}
        descriptionClassName="truncate"
        disabled={query.isPending}
        trailing={query.isPending ? <Spinner className="size-4" /> : undefined}
        onClick={() => {
          setConnectError(null);
          setConfirmDisconnect(false);
          setOpen(true);
        }}
      />

      <BottomSheet
        open={open}
        onOpenChange={(next) => {
          if (!connecting && !disconnecting) setOpen(next);
        }}
        title={t("settings.channels.telegram.label")}
        description={t("settings.channels.telegram.sheetDescription")}
      >
        {query.isPending ? (
          <div className="space-y-2 py-1">
            <SkeletonBlock className="h-4 w-2/3" />
            <SkeletonBlock className="h-4 w-1/2" />
          </div>
        ) : null}

        {query.isError ? (
          <OperationalState
            title={t("settings.channels.telegram.errorTitle")}
            body={t("settings.channels.telegram.errorBody")}
            tone="danger"
            onRetry={() => void query.refetch()}
          />
        ) : null}

        {query.isSuccess && telegram ? (
          <div className="space-y-4 pb-2">
            <SectionRows>
              <SectionRow
                label={t("settings.channels.telegram.bot")}
                value={telegram.displayName ?? handle}
              />
              {telegram.handle ? (
                <SectionRow label={t("settings.channels.telegram.handle")} value={handle} />
              ) : null}
              <SectionRow
                label={t("settings.channels.telegram.status")}
                value={t(`settings.channels.telegram.statusValue.${telegram.status}`)}
              />
              {telegram.health ? (
                <SectionRow
                  label={t("settings.channels.telegram.lastInbound")}
                  value={
                    telegram.health.lastInboundAt
                      ? fullTimestamp(telegram.health.lastInboundAt)
                      : t("settings.channels.telegram.never")
                  }
                />
              ) : null}
            </SectionRows>

            {canDisconnect ? (
              confirmDisconnect ? (
                <div className="space-y-2" role="group">
                  <p className="text-body-sm text-text-secondary">
                    {t("settings.channels.telegram.disconnectConfirmBody")}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="tap-target h-12 flex-1"
                      disabled={disconnecting}
                      onClick={() => setConfirmDisconnect(false)}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      className="tap-target h-12 flex-1"
                      disabled={disconnecting}
                      aria-busy={disconnecting}
                      onClick={() => void disconnect()}
                    >
                      {disconnecting ? <Spinner /> : null}
                      {t("settings.channels.telegram.disconnectAction")}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="tap-target h-12 w-full text-status-danger-text"
                  onClick={() => setConfirmDisconnect(true)}
                >
                  {t("settings.channels.telegram.disconnect")}
                </Button>
              )
            ) : null}
          </div>
        ) : null}

        {query.isSuccess && !telegram ? (
          <div className="space-y-4 pb-2">
            <ol className="text-body-sm list-decimal space-y-1.5 ps-5 text-text-secondary">
              <li>{t("settings.channels.telegram.step1")}</li>
              <li>{t("settings.channels.telegram.step2")}</li>
              <li>{t("settings.channels.telegram.step3")}</li>
            </ol>

            {canConnect ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void connect();
                }}
              >
                <Label htmlFor="telegram-bot-token">
                  {t("settings.channels.telegram.tokenLabel")}
                </Label>
                <Input
                  id="telegram-bot-token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(event) => {
                    setToken(event.target.value);
                    setConnectError(null);
                  }}
                  aria-invalid={connectError !== null}
                  {...(connectError ? { "aria-describedby": "telegram-connect-error" } : {})}
                  className="h-12"
                />
                {connectError ? (
                  <p
                    id="telegram-connect-error"
                    role="alert"
                    className="text-caption text-status-danger-text"
                  >
                    {t(`settings.channels.telegram.connectError.${connectError}`)}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  className="tap-target h-12 w-full"
                  disabled={connecting || token.trim().length === 0}
                  aria-busy={connecting}
                >
                  {connecting ? <Spinner /> : null}
                  {connecting
                    ? t("settings.channels.telegram.connecting")
                    : t("settings.channels.telegram.connect")}
                </Button>
              </form>
            ) : (
              <p className="text-caption text-text-secondary" role="status">
                {t("settings.channels.telegram.ownerOnly")}
              </p>
            )}
          </div>
        ) : null}
      </BottomSheet>
    </>
  );
}
