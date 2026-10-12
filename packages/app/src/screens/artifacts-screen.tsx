// PW build: the Artifacts list, like the Claude desktop app's. The rows come from the desktop
// app, which asks a short Claude Code chat for them (card "Our own Paseo build" on the board).
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isElectronRuntime } from "@/desktop/host";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { settingsStyles } from "@/styles/settings";
import { openExternalUrl } from "@/utils/open-external-url";

interface ArtifactRow {
  title: string;
  url: string;
  updated: string;
}

type ArtifactsResult = { ok: true; rows: ArtifactRow[] } | { ok: false; error: string };

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; rows: ArtifactRow[] }
  | { kind: "error"; message: string };

// The last list survives leaving the screen, so coming back shows it while it refreshes.
let lastRows: ArtifactRow[] | null = null;

export function ArtifactsScreen(): ReactElement {
  const isDesktop = isElectronRuntime();
  const [state, setState] = useState<LoadState>(
    lastRows ? { kind: "loaded", rows: lastRows } : { kind: "loading" },
  );
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const result = await invokeDesktopCommand<ArtifactsResult>("pw_list_artifacts");
      if (result.ok) {
        lastRows = result.rows;
        setState({ kind: "loaded", rows: result.rows });
      } else {
        setState({ kind: "error", message: result.error });
      }
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (isDesktop) void load();
  }, [isDesktop, load]);

  const refreshButton = isDesktop ? (
    <Button variant="ghost" onPress={() => void load()} disabled={isRefreshing}>
      {isRefreshing ? "Refreshing…" : "Refresh"}
    </Button>
  ) : undefined;

  return (
    <View style={styles.container}>
      <MenuHeader title="Artifacts" rightContent={refreshButton} />
      {isDesktop ? (
        <ArtifactsBody state={state} onRetry={() => void load()} />
      ) : (
        <View style={styles.centered}>
          <Text style={styles.message}>The Artifacts list works in the desktop app.</Text>
        </View>
      )}
    </View>
  );
}

function ArtifactsBody({
  state,
  onRetry,
}: {
  state: LoadState;
  onRetry: () => void;
}): ReactElement {
  if (state.kind === "loading") {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
        <Text style={styles.message}>Asking Claude for your artifacts…</Text>
      </View>
    );
  }
  if (state.kind === "error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>The artifacts list could not be loaded.</Text>
        <Text style={styles.detail}>{state.message}</Text>
        <Button variant="ghost" onPress={onRetry}>
          Try again
        </Button>
      </View>
    );
  }
  if (state.rows.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>No artifacts.</Text>
      </View>
    );
  }
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={settingsStyles.card}>
        {state.rows.map((row, index) => (
          <Pressable
            key={row.url}
            accessibilityRole="link"
            onPress={() => void openExternalUrl(row.url)}
            style={({ hovered }) => [
              settingsStyles.row,
              index > 0 && settingsStyles.rowBorder,
              hovered && styles.rowHovered,
            ]}
          >
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle} numberOfLines={1}>
                {row.title}
              </Text>
              {row.updated ? (
                <Text style={settingsStyles.rowHint}>Updated {row.updated}</Text>
              ) : null}
            </View>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[4],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  // Static color holder read by the spinner.
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
