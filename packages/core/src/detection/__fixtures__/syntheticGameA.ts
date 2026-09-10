/**
 * Synthetic fixtures for the Detection Engine's acceptance tests (Task 6).
 *
 * `SYNTHETIC_CATALOG` covers two invented product families:
 *
 *  1. "Game A" and its four platform/distribution variants ("Game A
 *     Mobile", "Game A Global", "Game A Garena", "Game A PC") — this is the
 *     AC-11 fixture. These five names must never appear anywhere else in
 *     the engine or knowledge files: their only purpose is to prove the
 *     detection pipeline works end-to-end against a catalog it has never
 *     seen tuned for it.
 *  2. The spec's own 7-entity AC-03 acceptance example ("Delta Force",
 *     "Delta Force Garena", "Free Fire", "Free Fire MAX", "PUBG Mobile",
 *     "PUBG Lite", "PUBG PC") — these ARE explicitly named in the original
 *     spec as the acceptance example, so they belong here as fixture data,
 *     not as "real catalog data" (the audit backing Task 1 confirmed the
 *     real Digiflazz catalog has no entries patterned this way).
 *
 * Every knowledge token these seven names need (`mobile`, `pc`, `lite`,
 * `max`, `garena`) already exists in `DEFAULT_KNOWLEDGE_BASE` (Task 1), so
 * `SYNTHETIC_KNOWLEDGE` below is a plain revision-bumped copy — no new
 * tokens were needed for this fixture set.
 */

import type { CatalogEntry, KnowledgeBase } from "../types";
import { DEFAULT_KNOWLEDGE_BASE } from "../knowledge/defaultVocabulary";

export const SYNTHETIC_KNOWLEDGE: KnowledgeBase = {
  ...DEFAULT_KNOWLEDGE_BASE,
  revision: "synthetic-fixture-v1",
};

export const SYNTHETIC_CATALOG: CatalogEntry[] = [
  // --- AC-11 fixture: "Game A" family (never referenced anywhere else) ---
  {
    refId: "gameA-base",
    productName: "Game A",
    externalId: "EXT-GAMEA-BASE",
    category: "games",
    type: "topup",
  },
  {
    refId: "gameA-mobile",
    productName: "Game A Mobile",
    externalId: "EXT-GAMEA-MOBILE",
    category: "games",
    type: "topup",
  },
  {
    refId: "gameA-global",
    productName: "Game A Global",
    externalId: "EXT-GAMEA-GLOBAL",
    category: "games",
    type: "topup",
  },
  {
    refId: "gameA-garena",
    productName: "Game A Garena",
    externalId: "EXT-GAMEA-GARENA",
    category: "games",
    type: "topup",
  },
  {
    refId: "gameA-pc",
    productName: "Game A PC",
    externalId: "EXT-GAMEA-PC",
    category: "games",
    type: "topup",
  },

  // --- AC-03 fixture: the spec's own 7-entity acceptance example ---
  {
    refId: "deltaforce-base",
    productName: "Delta Force",
    externalId: "EXT-DF-BASE",
    category: "games",
    type: "topup",
  },
  {
    refId: "deltaforce-garena",
    productName: "Delta Force Garena",
    externalId: "EXT-DF-GARENA",
    category: "games",
    type: "topup",
  },
  {
    refId: "freefire-base",
    productName: "Free Fire",
    externalId: "EXT-FF-BASE",
    category: "games",
    type: "topup",
  },
  {
    refId: "freefire-max",
    productName: "Free Fire MAX",
    externalId: "EXT-FF-MAX",
    category: "games",
    type: "topup",
  },
  {
    refId: "pubg-mobile",
    productName: "PUBG Mobile",
    externalId: "EXT-PUBG-MOBILE",
    category: "games",
    type: "topup",
  },
  {
    refId: "pubg-lite",
    productName: "PUBG Lite",
    externalId: "EXT-PUBG-LITE",
    category: "games",
    type: "topup",
  },
  {
    refId: "pubg-pc",
    productName: "PUBG PC",
    externalId: "EXT-PUBG-PC",
    category: "games",
    type: "topup",
  },
];
