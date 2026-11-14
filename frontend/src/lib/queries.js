// Server data hooks (TanStack Query). Each hook owns one query key; socket events in
// lib/socket.js invalidate those keys so every page stays live without polling.
import { QueryClient, useQuery } from "@tanstack/react-query";
import { get } from "./api.js";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => count < 1 && !(err?.status >= 400 && err?.status < 500),
    },
  },
});

const staticOpts = { staleTime: Infinity };

export const useSummary = (id) =>
  useQuery({ queryKey: ["summary", id], queryFn: () => get(`/astronauts/${id}/summary`), enabled: !!id });

export const useHistory = (id, indicator, days = 7) =>
  useQuery({
    queryKey: ["history", id, indicator, days],
    queryFn: () => get(`/astronauts/${id}/history?indicator=${indicator}&days=${days}`),
    enabled: !!id && !!indicator,
    placeholderData: (prev) => prev,
  });

// Inside the station, or outside on a spacewalk (EVA): the top bar's Location pill.
export const useLocationStatus = (id) =>
  useQuery({ queryKey: ["location", id], queryFn: () => get(`/astronauts/${id}/location`), enabled: !!id });
export const useCrew = (enabled = true) => useQuery({ queryKey: ["crew"], queryFn: () => get("/crew"), enabled });
export const useMission = () => useQuery({ queryKey: ["mission"], queryFn: () => get("/mission") });
export const useContent = () => useQuery({ queryKey: ["content"], queryFn: () => get("/content"), ...staticOpts });
export const useHealthRules = () => useQuery({ queryKey: ["rules"], queryFn: () => get("/health-rules"), ...staticOpts });
// Station voice (engine/voice/effects), chosen on /admin.
export const useVoiceSettings = () =>
  useQuery({ queryKey: ["voice-settings"], queryFn: () => get("/voice-settings"), staleTime: 15_000 });
export const useSymptomCatalog = () =>
  useQuery({ queryKey: ["symptomCatalog"], queryFn: () => get("/symptoms/catalog"), ...staticOpts });
export const useRoutine = () => useQuery({ queryKey: ["routine"], queryFn: () => get("/routine"), ...staticOpts });
// Today's routine on the mission clock with each task's live status. Also refetched now
// and then so "due" turns into "missed" on time (no broadcast marks that moment).
export const useSchedule = (id) =>
  useQuery({ queryKey: ["schedule", id], queryFn: () => get(`/astronauts/${id}/schedule`), enabled: !!id, refetchInterval: 20000 });
// One crew member's thread with the Flight Surgeon (delay-aware on the server).
export const useThread = (id) =>
  useQuery({ queryKey: ["thread", id], queryFn: () => get(`/astronauts/${id}/messages`), enabled: !!id });
export const useTags = () => useQuery({ queryKey: ["tags"], queryFn: () => get("/tags") });
export const useAlerts = (enabled = true) => useQuery({ queryKey: ["alerts"], queryFn: () => get("/alerts"), enabled });
export const useMessages = (enabled = true) =>
  useQuery({ queryKey: ["messages"], queryFn: () => get("/messages"), enabled });
export const useJournal = (id) =>
  useQuery({ queryKey: ["journal", id], queryFn: () => get(`/astronauts/${id}/journal`), enabled: !!id });
// "Wanna talk?" voice tone estimates (kept apart from self-reported mood). The status says
// whether this laptop can make them (optional model); re-checked while it's still loading.
export const useVoiceToneStatus = () =>
  useQuery({ queryKey: ["voice-tone-status"], queryFn: () => get("/voice-tone/status"),
    refetchInterval: (q) => (q.state.data?.state === "loading" || q.state.data?.state === "idle" ? 3000 : false) });
// The latest FINISHED "Wanna talk?" conversation and its own result (Mind page). Polled only
// while it's still being analysed; otherwise the voice_talk / voice_tone events refresh it.
// Face Analysis (Mind page): whether this laptop can run it, and the last report.
// A 404 means the running backend predates Face Analysis: don't retry it, and re-check every
// 5 s so the card recovers by itself once the backend is restarted.
const noRetryOn404 = (count, err) => err?.status !== 404 && count < 3;
export const useFaceStatus = () =>
  useQuery({ queryKey: ["face-status"], queryFn: () => get("/face/status"), retry: noRetryOn404,
    refetchInterval: (q) => (q.state.data?.state === "loading" || q.state.data?.state === "idle" || q.state.error ? (q.state.error ? 5000 : 3000) : false) });
export const useLatestFace = (id) =>
  useQuery({ queryKey: ["face-latest", id], queryFn: () => get(`/astronauts/${id}/face/latest`), enabled: !!id, retry: noRetryOn404,
    refetchInterval: (q) => (q.state.error?.status === 404 ? 5000 : false) });
// Pose Analysis (Mind page): same pattern as Face Analysis, its own routes and report.
export const usePoseStatus = () =>
  useQuery({ queryKey: ["pose-status"], queryFn: () => get("/pose/status"), retry: noRetryOn404,
    refetchInterval: (q) => (q.state.data?.state === "loading" || q.state.data?.state === "idle" || q.state.error ? (q.state.error ? 5000 : 3000) : false) });
export const useLatestPose = (id) =>
  useQuery({ queryKey: ["pose-latest", id], queryFn: () => get(`/astronauts/${id}/pose/latest`), enabled: !!id, retry: noRetryOn404,
    refetchInterval: (q) => (q.state.error?.status === 404 ? 5000 : false) });
export const useLatestVoiceTalk = (id) =>
  useQuery({ queryKey: ["voice-talk-latest", id], queryFn: () => get(`/astronauts/${id}/voice-talks/latest`), enabled: !!id,
    refetchInterval: (q) => (q.state.data?.talk?.status === "analysing" ? 2000 : false) });
export const useVoiceTone = (id, days = 7) =>
  useQuery({ queryKey: ["voice-tone", id, days], queryFn: () => get(`/astronauts/${id}/voice-tone?days=${days}`), enabled: !!id });
