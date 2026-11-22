# Verified Crowdwide Knowledge

This file is the curated, repository-backed source of truth for Crowdwide AI.
Update it when product behavior changes, and verify claims against the code and
project documentation before adding them. It is not a source for live user
counts, current production state, partnerships, or dated release history.

## Overview

Crowdwide is a social discovery platform built around communities and curiosity
instead of follower counts. People can publish posts, articles, and polls; join
open or private communities; discover discussions; and communicate through
direct and group chats. The project documentation does not state a separate,
formal mission or vision beyond this product purpose.

## Features

- Posts, articles, polls, drafts, scheduled publishing, comments, replies,
  reactions, likes, saves, quotes, and mentions.
- Open and private communities with membership, join requests, moderation,
  guidelines, and community feeds.
- A personalized "For you" feed, people and community discovery, and search
  across posts, people, communities, and hashtags.
- Direct messages and group chats, plus in-app notifications and optional
  browser push notifications.
- Profile privacy controls, moderation and reporting, account security,
  accessibility pages, and user data export and deletion.

These are capabilities documented in the repository; availability can depend
on account permissions and deployment configuration.

## AI Assistant

Crowdwide AI is an authenticated assistant in the existing Crowdwide app. It
keeps private conversation history and user-managed memories, retrieves
privacy-filtered Crowdwide content, and provides source links. Its language
model runs in the member's browser: the current implementation uses
Transformers.js and ONNX Runtime Web, preferring WebGPU when usable and
supporting CPU/WASM without WebGPU. Search-based answers remain available when
local inference is disabled or fails.

The server validates social-action targets and permissions. Post, comment,
reply, and direct/group message actions require the user to review and confirm
the proposed action before existing authenticated handlers execute it.

## Architecture

The application is an Express MVC project using EJS views, MongoDB through
Mongoose, and session-based authentication. Existing routes and models enforce
ownership, membership, privacy, and moderation rules. The AI's local inference
worker runs in the browser; it is not hosted as a paid inference service by
Crowdwide.

## Current State And Unknowns

The repository documents the features and implementation described above. It
does not contain a dated product release log, verified live usage statistics,
or a source of truth for the latest production deployment changes. Crowdwide AI
must not infer those facts from repository presence or user-generated posts.
