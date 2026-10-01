// ==UserScript==
// @name         Spotranslate
// @namespace    https://www.koozz.nl/userscripts/spotranslate.js
// @version      1.0.0
// @description  Translate Spotify lyrics with Google Translate.
// @match        https://open.spotify.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      translate.googleapis.com
// ==/UserScript==

(() => {
	"use strict";

	const TARGET_LANGUAGE = "nl";
	// To translate to English, comment out the line above and use:
	// const TARGET_LANGUAGE = "en";
	const TRANSLATED_LYRICS_FONT_SIZE = "0.75em";
	const TRANSLATION_CACHE_KEY = "translation-cache";
	const MAX_CACHED_TRANSLATIONS = 1000;

	const LYRIC_LINE_SELECTOR = "div[data-testid='lyrics-line']";
	const TRANSLATION_ENDPOINT =
		"https://translate.googleapis.com/translate_a/single";

	const translationCache = new Map();
	const storedTranslations = GM_getValue(TRANSLATION_CACHE_KEY, {});
	const inFlightTranslations = new Map();
	let lyricsObserver;
	let repairScheduled = false;
	let repairInFlight = false;
	let repairRequested = false;

	const style = document.createElement("style");
	style.textContent = `
		[data-spotranslate-translation]::after {
			content: attr(data-spotranslate-translation) !important;
			display: block !important;
			font-size: ${TRANSLATED_LYRICS_FONT_SIZE} !important;
			line-height: 1em !important;
			margin-bottom: 10px;
			opacity: .5 !important;
			visibility: visible !important;
			pointer-events: none;
			white-space: pre-wrap !important;
		}
	`;
	document.head.appendChild(style);

	function isTranslatable(text) {
		return Boolean(text && /\p{L}|\p{N}/u.test(text));
	}

	function normalizeText(text) {
		return text.replace(/\s+/g, " ").trim();
	}

	function getCachedTranslation(text) {
		const cacheKey = `${TARGET_LANGUAGE}|${normalizeText(text)}`;
		if (translationCache.has(cacheKey)) {
			return translationCache.get(cacheKey);
		}
		if (storedTranslations[cacheKey]) {
			translationCache.set(cacheKey, storedTranslations[cacheKey]);
			return storedTranslations[cacheKey];
		}
		return null;
	}

	function googleTranslate(text) {
		const url = new URL(TRANSLATION_ENDPOINT);
		url.search = new URLSearchParams({
			client: "gtx",
			dt: "t",
			sl: "auto",
			tl: TARGET_LANGUAGE,
			q: text,
		});

		return new Promise((resolve, reject) => {
			GM_xmlhttpRequest({
				method: "GET",
				url: url.toString(),
				onload(response) {
					if (response.status < 200 || response.status >= 300) {
						reject(new Error(`Google Translate returned ${response.status}`));
						return;
					}

					try {
						const data = JSON.parse(response.responseText);
						const result = data[0]?.map((part) => part[0]).join("");
						if (!result) {
							throw new Error("Google Translate returned no text");
						}
						resolve(result);
					} catch (error) {
						reject(error);
					}
				},
				onerror() {
					reject(new Error("Google Translate request failed"));
				},
			});
		});
	}

	async function translateText(text) {
		if (!isTranslatable(text)) return text;

		const normalizedText = normalizeText(text);
		const cacheKey = `${TARGET_LANGUAGE}|${normalizedText}`;
		const cachedTranslation = getCachedTranslation(text);
		if (cachedTranslation) return cachedTranslation;
		if (inFlightTranslations.has(cacheKey)) {
			return inFlightTranslations.get(cacheKey);
		}

		const request = googleTranslate(normalizedText)
			.then((translation) => {
				translationCache.set(cacheKey, translation);
				storedTranslations[cacheKey] = translation;
				const keys = Object.keys(storedTranslations);
				if (keys.length > MAX_CACHED_TRANSLATIONS) {
					delete storedTranslations[keys[0]];
				}
				GM_setValue(TRANSLATION_CACHE_KEY, storedTranslations);
				return translation;
			})
			.finally(() => inFlightTranslations.delete(cacheKey));

		inFlightTranslations.set(cacheKey, request);
		return request;
	}

	function replaceLyric(wrapper, text, translation) {
		if (translation == null || !wrapper.parentElement) return;

		wrapper.dataset.spotranslateSource = normalizeText(text);
		wrapper.dataset.spotranslateTranslation = translation;
		wrapper.classList.add("spotranslate-translated");
	}

	async function translateLine(wrapper) {
		const text = wrapper.textContent?.trim();
		if (!text) return;
		const normalizedText = normalizeText(text);
		if (
			wrapper.dataset.spotranslateSource === normalizedText &&
			wrapper.dataset.spotranslateTranslation
		) {
			wrapper.classList.add("spotranslate-translated");
			return;
		}

		const cachedTranslation = getCachedTranslation(text);
		if (cachedTranslation) {
			replaceLyric(wrapper, text, cachedTranslation);
			return;
		}

		try {
			replaceLyric(wrapper, text, await translateText(text));
		} catch (error) {
			console.error("Spotranslate: could not translate lyric", error);
		}
	}

	async function translateVisibleLyrics() {
		const lines = [...document.querySelectorAll(LYRIC_LINE_SELECTOR)];
		await Promise.all(lines.map(translateLine));
	}

	function observeLyrics() {
		lyricsObserver?.disconnect();

		lyricsObserver = new MutationObserver(scheduleRepair);
		lyricsObserver.observe(document.body, {
			attributes: true,
			attributeFilter: [
				"data-spotranslate-source",
				"data-spotranslate-translation",
			],
			childList: true,
			subtree: true,
		});
	}

	function scheduleRepair() {
		repairRequested = true;
		if (repairScheduled) return;
		repairScheduled = true;
		queueMicrotask(async () => {
			repairScheduled = false;
			if (repairInFlight) return;
			repairRequested = false;
			repairInFlight = true;
			try {
				await translateVisibleLyrics();
			} finally {
				repairInFlight = false;
				if (repairRequested) scheduleRepair();
			}
		});
	}

	if (document.body) {
		observeLyrics();
		scheduleRepair();
	} else {
		window.addEventListener(
			"DOMContentLoaded",
			() => {
				observeLyrics();
				scheduleRepair();
			},
			{ once: true },
		);
	}
})();
