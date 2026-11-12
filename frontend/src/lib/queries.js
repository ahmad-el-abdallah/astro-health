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
