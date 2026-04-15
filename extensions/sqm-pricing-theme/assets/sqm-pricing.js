(function () {
  "use strict";

  const BLOCK_SELECTOR = "[data-sqm-pricing]";
  const LENGTH_INPUT_SELECTOR = "[data-sqm-length]";
  const WIDTH_INPUT_SELECTOR = "[data-sqm-width]";
  const AREA_OUTPUT_SELECTOR = "[data-sqm-area]";
  const TOTAL_OUTPUT_SELECTOR = "[data-sqm-total]";
  const ERROR_OUTPUT_SELECTOR = "[data-sqm-error]";
  const VARIANT_PRICES_SELECTOR = "[data-sqm-variant-prices]";
  const VARIANTS_SELECTOR = "[data-sqm-variants]";
  const MM_PER_METER = 1000;
  const SQM_PROPERTIES_BY_VARIANT = new Map();
  const SQM_TARGET_VARIANT_BY_SOURCE = new Map();
  const SQM_PROPERTY_KEYS = ["length_mm", "width_mm", "length", "width", "area"];
  const SQM_UID_PROPERTY_KEY = "_sqm_uid";
  const SELECTED_VARIANT_PROPERTY_KEY = "_selected_variant_id";
  let cartRequestHooksInstalled = false;

  function parseNumber(value) {
    if (typeof value !== "string") return null;
    const trimmedValue = value.trim();
    if (!trimmedValue) return null;

    const parsed = Number.parseFloat(trimmedValue);
    if (!Number.isFinite(parsed)) return null;

    return parsed;
  }

  function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  function normalizeDecimal(value, decimals) {
    return round(value, decimals).toString();
  }

  function formatArea(value) {
    return normalizeDecimal(value, 4);
  }

  function getCurrencyFormatter(locale, currency) {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
      });
    } catch (error) {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      });
    }
  }

  function upsertHiddenInput(form, name, value) {
    let hiddenInput = form.querySelector(`input[name="${name}"]`);
    if (!hiddenInput) {
      hiddenInput = document.createElement("input");
      hiddenInput.type = "hidden";
      hiddenInput.name = name;
      form.appendChild(hiddenInput);
    }

    hiddenInput.value = value;
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function getVariantIdFromForm(form) {
    const variantInput = form.querySelector('[name="id"]');
    if (!variantInput) return null;

    const variantId = variantInput.value ? String(variantInput.value) : "";
    return variantId || null;
  }

  function generateSqmUid() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function buildPropertiesFromMeasurement(measurement) {
    return {
      length_mm: normalizeDecimal(measurement.lengthMm, 2),
      width_mm: normalizeDecimal(measurement.widthMm, 2),
      length: formatArea(measurement.length),
      width: formatArea(measurement.width),
      area: formatArea(measurement.area),
    };
  }

  function applyPropertiesToForm(form, properties) {
    if (!isPlainObject(properties)) return;

    Object.entries(properties).forEach(([propertyKey, value]) => {
      if (typeof value !== "string") return;
      upsertHiddenInput(form, `properties[${propertyKey}]`, value);
    });
  }

  function getSqmPropertiesForVariant(variantId) {
    if (variantId === null || variantId === undefined) return null;
    return SQM_PROPERTIES_BY_VARIANT.get(String(variantId)) || null;
  }

  function parseItemIndexKey(key) {
    const matched = /^items\[(\d+)\]\[(id|variant_id)\]$/.exec(key);
    if (!matched) return null;
    return {
      itemIndex: matched[1],
      keyType: matched[2],
    };
  }

  function resolveMappedVariantId(variantId) {
    if (variantId === null || variantId === undefined) return null;

    const normalizedVariantId = String(variantId).trim();
    if (!normalizedVariantId) return null;

    const mappedVariantId = SQM_TARGET_VARIANT_BY_SOURCE.get(normalizedVariantId);
    if (mappedVariantId && mappedVariantId !== normalizedVariantId) {
      return mappedVariantId;
    }

    return normalizedVariantId;
  }

  function applyPropertiesToItemRecord(item) {
    if (!isPlainObject(item)) {
      return {
        changed: false,
        item,
      };
    }

    const sourceVariantId = item.id ?? item.variant_id;
    const normalizedSourceVariantId =
      sourceVariantId === null || sourceVariantId === undefined ? null : String(sourceVariantId).trim();
    const mappedVariantId = resolveMappedVariantId(normalizedSourceVariantId);
    const targetVariantId = mappedVariantId || normalizedSourceVariantId;

    let nextItem = item;
    let changed = false;

    if (
      normalizedSourceVariantId &&
      mappedVariantId &&
      mappedVariantId !== normalizedSourceVariantId
    ) {
      nextItem = { ...nextItem };

      if (Object.prototype.hasOwnProperty.call(nextItem, "id")) {
        nextItem.id = mappedVariantId;
      }

      if (Object.prototype.hasOwnProperty.call(nextItem, "variant_id")) {
        nextItem.variant_id = mappedVariantId;
      }

      changed = true;
    }

    const sqmProperties = getSqmPropertiesForVariant(targetVariantId);
    if (!sqmProperties && !changed) {
      return {
        changed: false,
        item,
      };
    }

    const existingProperties = isPlainObject(nextItem.properties) ? nextItem.properties : {};
    const nextProperties = { ...existingProperties };
    let propertiesChanged = false;

    if (
      normalizedSourceVariantId &&
      mappedVariantId &&
      mappedVariantId !== normalizedSourceVariantId &&
      (
        typeof nextProperties[SELECTED_VARIANT_PROPERTY_KEY] !== "string" ||
        !nextProperties[SELECTED_VARIANT_PROPERTY_KEY].trim()
      )
    ) {
      nextProperties[SELECTED_VARIANT_PROPERTY_KEY] = normalizedSourceVariantId;
      propertiesChanged = true;
    }

    if (sqmProperties) {
      SQM_PROPERTY_KEYS.forEach((propertyKey) => {
        if (typeof nextProperties[propertyKey] === "string") return;
        const sqmValue = sqmProperties[propertyKey];
        if (typeof sqmValue !== "string") return;
        nextProperties[propertyKey] = sqmValue;
        propertiesChanged = true;
      });
    }

    if (typeof nextProperties[SQM_UID_PROPERTY_KEY] !== "string" || !nextProperties[SQM_UID_PROPERTY_KEY].trim()) {
      nextProperties[SQM_UID_PROPERTY_KEY] = generateSqmUid();
      propertiesChanged = true;
    }

    if (propertiesChanged) {
      if (nextItem === item) {
        nextItem = { ...nextItem };
      }
      nextItem.properties = nextProperties;
      changed = true;
    }

    if (!changed) {
      return {
        changed: false,
        item,
      };
    }

    return {
      changed: true,
      item: nextItem,
    };
  }

  function applyPropertiesToJsonBody(payload) {
    if (!isPlainObject(payload)) {
      return {
        changed: false,
        body: payload,
      };
    }

    if (Array.isArray(payload.items)) {
      let changed = false;
      const nextItems = payload.items.map((item) => {
        const applied = applyPropertiesToItemRecord(item);
        if (applied.changed) changed = true;
        return applied.item;
      });

      if (!changed) {
        return {
          changed: false,
          body: payload,
        };
      }

      return {
        changed: true,
        body: {
          ...payload,
          items: nextItems,
        },
      };
    }

    const appliedTopLevelItem = applyPropertiesToItemRecord(payload);
    return {
      changed: appliedTopLevelItem.changed,
      body: appliedTopLevelItem.item,
    };
  }

  function applyPropertiesToSearchParams(searchParams) {
    let changed = false;
    const topLevelOriginalVariantId = String(
      searchParams.get("id") || searchParams.get("variant_id") || "",
    ).trim();
    const topLevelMappedVariantId = resolveMappedVariantId(topLevelOriginalVariantId);
    const topLevelVariantId = topLevelMappedVariantId || topLevelOriginalVariantId;

    if (
      topLevelOriginalVariantId &&
      topLevelMappedVariantId &&
      topLevelMappedVariantId !== topLevelOriginalVariantId
    ) {
      if (searchParams.has("id")) {
        searchParams.set("id", topLevelMappedVariantId);
        changed = true;
      }

      if (searchParams.has("variant_id")) {
        searchParams.set("variant_id", topLevelMappedVariantId);
        changed = true;
      }
    }

    const topLevelProperties = getSqmPropertiesForVariant(topLevelVariantId);

    if (topLevelProperties) {
      SQM_PROPERTY_KEYS.forEach((propertyKey) => {
        const value = topLevelProperties[propertyKey];
        const targetKey = `properties[${propertyKey}]`;
        if (typeof value === "string" && !searchParams.has(targetKey)) {
          searchParams.set(targetKey, value);
          changed = true;
        }
      });

      const uidKey = `properties[${SQM_UID_PROPERTY_KEY}]`;
      if (!searchParams.has(uidKey)) {
        searchParams.set(uidKey, generateSqmUid());
        changed = true;
      }
    }

    if (
      topLevelOriginalVariantId &&
      topLevelMappedVariantId &&
      topLevelMappedVariantId !== topLevelOriginalVariantId
    ) {
      const selectedVariantKey = `properties[${SELECTED_VARIANT_PROPERTY_KEY}]`;
      if (!searchParams.has(selectedVariantKey)) {
        searchParams.set(selectedVariantKey, topLevelOriginalVariantId);
        changed = true;
      }
    }

    const itemVariantIdsByIndex = new Map();
    for (const [key, value] of searchParams.entries()) {
      const parsed = parseItemIndexKey(key);
      if (!parsed) continue;

      const originalVariantId = String(value || "").trim();
      const mappedVariantId = resolveMappedVariantId(originalVariantId);
      const effectiveVariantId = mappedVariantId || originalVariantId;

      if (
        originalVariantId &&
        mappedVariantId &&
        mappedVariantId !== originalVariantId
      ) {
        searchParams.set(key, mappedVariantId);
        changed = true;
      }

      itemVariantIdsByIndex.set(parsed.itemIndex, {
        originalVariantId,
        effectiveVariantId,
      });
    }

    itemVariantIdsByIndex.forEach(({ originalVariantId, effectiveVariantId }, itemIndex) => {
      const sqmProperties = getSqmPropertiesForVariant(effectiveVariantId);
      if (!sqmProperties) return;

      SQM_PROPERTY_KEYS.forEach((propertyKey) => {
        const value = sqmProperties[propertyKey];
        const targetKey = `items[${itemIndex}][properties][${propertyKey}]`;
        if (typeof value === "string" && !searchParams.has(targetKey)) {
          searchParams.set(targetKey, value);
          changed = true;
        }
      });

      const uidKey = `items[${itemIndex}][properties][${SQM_UID_PROPERTY_KEY}]`;
      if (!searchParams.has(uidKey)) {
        searchParams.set(uidKey, generateSqmUid());
        changed = true;
      }

      if (
        originalVariantId &&
        effectiveVariantId &&
        effectiveVariantId !== originalVariantId
      ) {
        const selectedVariantKey = `items[${itemIndex}][properties][${SELECTED_VARIANT_PROPERTY_KEY}]`;
        if (!searchParams.has(selectedVariantKey)) {
          searchParams.set(selectedVariantKey, originalVariantId);
          changed = true;
        }
      }
    });

    return changed;
  }

  function applyPropertiesToFormData(formData) {
    let changed = false;
    const topLevelOriginalVariantId = String(
      formData.get("id") || formData.get("variant_id") || "",
    ).trim();
    const topLevelMappedVariantId = resolveMappedVariantId(topLevelOriginalVariantId);
    const topLevelVariantId = topLevelMappedVariantId || topLevelOriginalVariantId;

    if (
      topLevelOriginalVariantId &&
      topLevelMappedVariantId &&
      topLevelMappedVariantId !== topLevelOriginalVariantId
    ) {
      if (formData.has("id")) {
        formData.set("id", topLevelMappedVariantId);
        changed = true;
      }

      if (formData.has("variant_id")) {
        formData.set("variant_id", topLevelMappedVariantId);
        changed = true;
      }
    }

    const topLevelProperties = getSqmPropertiesForVariant(topLevelVariantId);

    if (topLevelProperties) {
      SQM_PROPERTY_KEYS.forEach((propertyKey) => {
        const value = topLevelProperties[propertyKey];
        const targetKey = `properties[${propertyKey}]`;
        if (typeof value === "string" && !formData.has(targetKey)) {
          formData.set(targetKey, value);
          changed = true;
        }
      });

      const uidKey = `properties[${SQM_UID_PROPERTY_KEY}]`;
      if (!formData.has(uidKey)) {
        formData.set(uidKey, generateSqmUid());
        changed = true;
      }
    }

    if (
      topLevelOriginalVariantId &&
      topLevelMappedVariantId &&
      topLevelMappedVariantId !== topLevelOriginalVariantId
    ) {
      const selectedVariantKey = `properties[${SELECTED_VARIANT_PROPERTY_KEY}]`;
      if (!formData.has(selectedVariantKey)) {
        formData.set(selectedVariantKey, topLevelOriginalVariantId);
        changed = true;
      }
    }

    const itemVariantIdsByIndex = new Map();
    for (const [key, value] of formData.entries()) {
      const parsed = parseItemIndexKey(key);
      if (!parsed) continue;

      const originalVariantId = String(value || "").trim();
      const mappedVariantId = resolveMappedVariantId(originalVariantId);
      const effectiveVariantId = mappedVariantId || originalVariantId;

      if (
        originalVariantId &&
        mappedVariantId &&
        mappedVariantId !== originalVariantId
      ) {
        formData.set(key, mappedVariantId);
        changed = true;
      }

      itemVariantIdsByIndex.set(parsed.itemIndex, {
        originalVariantId,
        effectiveVariantId,
      });
    }

    itemVariantIdsByIndex.forEach(({ originalVariantId, effectiveVariantId }, itemIndex) => {
      const sqmProperties = getSqmPropertiesForVariant(effectiveVariantId);
      if (!sqmProperties) return;

      SQM_PROPERTY_KEYS.forEach((propertyKey) => {
        const value = sqmProperties[propertyKey];
        const targetKey = `items[${itemIndex}][properties][${propertyKey}]`;
        if (typeof value === "string" && !formData.has(targetKey)) {
          formData.set(targetKey, value);
          changed = true;
        }
      });

      const uidKey = `items[${itemIndex}][properties][${SQM_UID_PROPERTY_KEY}]`;
      if (!formData.has(uidKey)) {
        formData.set(uidKey, generateSqmUid());
        changed = true;
      }

      if (
        originalVariantId &&
        effectiveVariantId &&
        effectiveVariantId !== originalVariantId
      ) {
        const selectedVariantKey = `items[${itemIndex}][properties][${SELECTED_VARIANT_PROPERTY_KEY}]`;
        if (!formData.has(selectedVariantKey)) {
          formData.set(selectedVariantKey, originalVariantId);
          changed = true;
        }
      }
    });

    return changed;
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function applySqmPropertiesToRequestBody(body, contentTypeHeader) {
    if (!body) {
      return {
        changed: false,
        body,
      };
    }

    if (body instanceof FormData) {
      const changed = applyPropertiesToFormData(body);
      return { changed, body };
    }

    if (body instanceof URLSearchParams) {
      const changed = applyPropertiesToSearchParams(body);
      return { changed, body };
    }

    if (isPlainObject(body)) {
      const applied = applyPropertiesToJsonBody(body);
      return {
        changed: applied.changed,
        body: applied.body,
      };
    }

    if (typeof body !== "string") {
      return {
        changed: false,
        body,
      };
    }

    const trimmedBody = body.trim();
    const contentType = String(contentTypeHeader || "").toLowerCase();
    const shouldTreatAsJson =
      contentType.includes("application/json") ||
      (trimmedBody.startsWith("{") && trimmedBody.endsWith("}"));

    if (shouldTreatAsJson) {
      const parsed = parseJson(trimmedBody);
      if (!parsed) {
        return {
          changed: false,
          body,
        };
      }

      const applied = applyPropertiesToJsonBody(parsed);
      return {
        changed: applied.changed,
        body: applied.changed ? JSON.stringify(applied.body) : body,
      };
    }

    const searchParams = new URLSearchParams(body);
    const changed = applyPropertiesToSearchParams(searchParams);
    return {
      changed,
      body: changed ? searchParams.toString() : body,
    };
  }

  function readHeaderValue(headers, targetHeaderName) {
    if (!headers) return null;

    const target = String(targetHeaderName || "").toLowerCase();
    if (!target) return null;

    if (headers instanceof Headers) {
      return headers.get(targetHeaderName);
    }

    if (Array.isArray(headers)) {
      for (const [headerName, headerValue] of headers) {
        if (String(headerName).toLowerCase() === target) {
          return String(headerValue);
        }
      }

      return null;
    }

    if (isPlainObject(headers)) {
      for (const [headerName, headerValue] of Object.entries(headers)) {
        if (String(headerName).toLowerCase() === target) {
          return String(headerValue);
        }
      }
    }

    return null;
  }

  function getRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;

    if (input && typeof input.url === "string") {
      return input.url;
    }

    return "";
  }

  function isCartAddRequestPath(pathname) {
    return /\/cart\/add(\.js)?$/.test(pathname);
  }

  function isCartAddRequestUrl(url) {
    if (!url) return false;

    try {
      const parsedUrl = new URL(url, window.location.origin);
      return isCartAddRequestPath(parsedUrl.pathname);
    } catch (error) {
      return false;
    }
  }

  function installCartRequestHooks() {
    if (cartRequestHooksInstalled) return;
    cartRequestHooksInstalled = true;

    if (typeof window.fetch === "function") {
      const originalFetch = window.fetch;
      window.fetch = function sqmFetch(input, init) {
        if (!isCartAddRequestUrl(getRequestUrl(input))) {
          return originalFetch.call(this, input, init);
        }

        if (!init || !Object.prototype.hasOwnProperty.call(init, "body")) {
          return originalFetch.call(this, input, init);
        }

        const patchedInit = { ...init };
        const contentTypeHeader = readHeaderValue(patchedInit.headers, "content-type");
        const patchedBody = applySqmPropertiesToRequestBody(patchedInit.body, contentTypeHeader);
        if (patchedBody.changed) {
          patchedInit.body = patchedBody.body;
        }

        return originalFetch.call(this, input, patchedInit);
      };
    }

    if (typeof window.XMLHttpRequest === "function") {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function sqmOpen(method, url, ...rest) {
        const requestMethod = typeof method === "string" ? method.toUpperCase() : "";
        this.__sqmShouldPatchCartRequest =
          requestMethod !== "GET" &&
          requestMethod !== "HEAD" &&
          isCartAddRequestUrl(String(url || ""));

        return originalOpen.call(this, method, url, ...rest);
      };

      XMLHttpRequest.prototype.send = function sqmSend(body) {
        if (!this.__sqmShouldPatchCartRequest) {
          return originalSend.call(this, body);
        }

        const patchedBody = applySqmPropertiesToRequestBody(body, null);
        return originalSend.call(this, patchedBody.changed ? patchedBody.body : body);
      };
    }
  }

  function findProductForms(root) {
    const sectionContainer =
      root.closest(".shopify-section") || root.closest('section[id^="shopify-section"]');
    const scope = sectionContainer || document;

    return Array.from(scope.querySelectorAll('form[action*="/cart/add"]'));
  }

  function getVariantPrices(root) {
    const variantPricesElement = root.querySelector(VARIANT_PRICES_SELECTOR);
    if (!variantPricesElement) return {};

    try {
      const raw = JSON.parse(variantPricesElement.textContent || "{}");
      return Object.entries(raw).reduce((accumulator, [variantId, amount]) => {
        const parsedAmount =
          typeof amount === "number" ? amount : parseNumber(String(amount ?? ""));
        if (parsedAmount !== null && parsedAmount > 0) {
          accumulator[String(variantId)] = parsedAmount;
        }

        return accumulator;
      }, {});
    } catch (error) {
      return {};
    }
  }

  function getVariantRecords(root) {
    const variantsElement = root.querySelector(VARIANTS_SELECTOR);
    if (!variantsElement) return [];

    try {
      const raw = JSON.parse(variantsElement.textContent || "[]");
      if (!Array.isArray(raw)) return [];

      return raw.reduce((variants, entry) => {
        if (!isPlainObject(entry)) return variants;

        const id = String(entry.id ?? "").trim();
        const price =
          typeof entry.price === "number"
            ? entry.price
            : parseNumber(String(entry.price ?? ""));
        if (!id || price === null || !Number.isFinite(price) || price <= 0) {
          return variants;
        }

        variants.push({
          id,
          price,
          title: String(entry.title ?? ""),
          sku: String(entry.sku ?? "").trim(),
          options: Array.isArray(entry.options)
            ? entry.options.map((value) => String(value ?? ""))
            : [],
        });

        return variants;
      }, []);
    } catch (error) {
      return [];
    }
  }

  function normalizeVariantText(value) {
    return String(value ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripAreaSuffixFromValue(value) {
    const normalized = normalizeVariantText(value);
    if (!normalized) return "";

    return normalized
      .replace(/\s*-\s*area\s*\([^)]*\)\s*[\d.,]+\s*sq\s*m(?:\s*-\s*item\.?\s*no-?\s*\d+)?\s*$/i, "")
      .replace(/\s*-\s*item\.?\s*no-?\s*\d+\s*$/i, "")
      .trim();
  }

  function hasAreaDescriptor(value) {
    return /area\s*\([^)]*\)/i.test(String(value ?? ""));
  }

  function parseAreaSqmFromValue(value) {
    const text = String(value ?? "");
    if (!text) return null;

    const matched = text.match(/area\s*\([^)]*\)\s*([\d.,]+)\s*sq\s*m/i);
    if (!matched) return null;

    const normalized = matched[1].replace(/,/g, "");
    const parsed = Number.parseFloat(normalized);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;

    return parsed;
  }

  function extractVariantAreaSqm(variant) {
    if (!variant) return null;

    const titleArea = parseAreaSqmFromValue(variant.title);
    if (titleArea !== null) return titleArea;

    if (!Array.isArray(variant.options)) return null;
    for (const optionValue of variant.options) {
      const optionArea = parseAreaSqmFromValue(optionValue);
      if (optionArea !== null) return optionArea;
    }

    return null;
  }

  function buildVariantIdentityTokens(variant) {
    if (!variant) return [];

    const tokens = new Set();
    const addToken = (value) => {
      const stripped = stripAreaSuffixFromValue(value);
      if (stripped) tokens.add(stripped);
    };

    addToken(variant.title);
    if (Array.isArray(variant.options)) {
      variant.options.forEach((value) => {
        addToken(value);
      });
    }

    return Array.from(tokens);
  }

  function resolvePricingVariantId(selectedVariantId, totalPrice, areaSqm, variants, variantsById) {
    const normalizedSelectedVariantId = String(selectedVariantId ?? "").trim();
    if (!normalizedSelectedVariantId) return null;
    const hasValidTotalPrice = Number.isFinite(totalPrice) && totalPrice > 0;
    const hasValidArea = Number.isFinite(areaSqm) && areaSqm > 0;
    if (!hasValidTotalPrice && !hasValidArea) return normalizedSelectedVariantId;
    if (!Array.isArray(variants) || variants.length === 0) return normalizedSelectedVariantId;

    const sourceVariant = variantsById.get(normalizedSelectedVariantId);
    if (!sourceVariant) return normalizedSelectedVariantId;

    const hasAreaStyleVariants = variants.some((variant) => {
      if (hasAreaDescriptor(variant.title)) return true;
      if (!Array.isArray(variant.options)) return false;
      return variant.options.some((value) => hasAreaDescriptor(value));
    });
    if (!hasAreaStyleVariants) return sourceVariant.id;

    let candidates = variants.filter((variant) => variant.id !== sourceVariant.id);
    if (candidates.length === 0) return sourceVariant.id;

    if (sourceVariant.sku) {
      const sameSkuCandidates = candidates.filter((variant) => variant.sku === sourceVariant.sku);
      if (sameSkuCandidates.length > 0) {
        candidates = sameSkuCandidates;
      }
    }

    const sourceTokens = new Set(buildVariantIdentityTokens(sourceVariant));
    if (sourceTokens.size > 0) {
      const identityMatchedCandidates = candidates.filter((variant) => {
        const variantTokens = buildVariantIdentityTokens(variant);
        return variantTokens.some((token) => sourceTokens.has(token));
      });
      if (identityMatchedCandidates.length > 0) {
        candidates = identityMatchedCandidates;
      }
    }

    if (candidates.length === 0) return sourceVariant.id;

    if (hasValidArea) {
      const areaCandidates = candidates
        .map((variant) => ({
          variant,
          area: extractVariantAreaSqm(variant),
        }))
        .filter((entry) => entry.area !== null);

      if (areaCandidates.length > 0) {
        let closestAreaCandidate = areaCandidates[0];
        let closestAreaDiff = Math.abs(closestAreaCandidate.area - areaSqm);

        areaCandidates.forEach((entry) => {
          const diff = Math.abs(entry.area - areaSqm);
          if (diff < closestAreaDiff) {
            closestAreaCandidate = entry;
            closestAreaDiff = diff;
          }
        });

        const sourceArea = extractVariantAreaSqm(sourceVariant);
        if (sourceArea !== null) {
          const sourceAreaDiff = Math.abs(sourceArea - areaSqm);
          if (sourceAreaDiff <= closestAreaDiff + 0.000001) {
            return sourceVariant.id;
          }
        }

        return closestAreaCandidate.variant.id;
      }
    }

    if (!hasValidTotalPrice) return sourceVariant.id;

    let closestVariant = candidates[0];
    let closestDiff = Math.abs(closestVariant.price - totalPrice);

    candidates.forEach((candidate) => {
      const diff = Math.abs(candidate.price - totalPrice);
      if (diff < closestDiff) {
        closestVariant = candidate;
        closestDiff = diff;
      }
    });

    const sourceDiff = Math.abs(sourceVariant.price - totalPrice);
    if (sourceDiff <= closestDiff + 0.000001) {
      return sourceVariant.id;
    }

    return closestVariant.id;
  }

  function getSelectedVariantId(forms) {
    for (const form of forms) {
      const variantId = getVariantIdFromForm(form);
      if (variantId) {
        return variantId;
      }
    }

    return null;
  }

  function getActiveUnitPrice(forms, fallbackUnitPrice, variantPrices) {
    const selectedVariantId = getSelectedVariantId(forms);

    if (selectedVariantId && variantPrices[selectedVariantId]) {
      return variantPrices[selectedVariantId];
    }

    return fallbackUnitPrice;
  }

  function initializeBlock(root) {
    if (root.dataset.sqmInitialized === "true") return;
    root.dataset.sqmInitialized = "true";

    const lengthInput = root.querySelector(LENGTH_INPUT_SELECTOR);
    const widthInput = root.querySelector(WIDTH_INPUT_SELECTOR);
    const areaOutput = root.querySelector(AREA_OUTPUT_SELECTOR);
    const totalOutput = root.querySelector(TOTAL_OUTPUT_SELECTOR);
    const errorOutput = root.querySelector(ERROR_OUTPUT_SELECTOR);

    if (!lengthInput || !widthInput || !areaOutput || !totalOutput || !errorOutput) {
      return;
    }

    const enabled = root.dataset.enabled === "true";
    const fallbackUnitPrice = parseNumber(root.dataset.unitPrice || "");

    if (!enabled || fallbackUnitPrice === null || fallbackUnitPrice <= 0) {
      return;
    }

    const minLength = parseNumber(root.dataset.minLength || "") ?? 0.1;
    const maxLength = parseNumber(root.dataset.maxLength || "") ?? 100;
    const minWidth = parseNumber(root.dataset.minWidth || "") ?? 0.1;
    const maxWidth = parseNumber(root.dataset.maxWidth || "") ?? 100;

    lengthInput.min = normalizeDecimal(minLength * MM_PER_METER, 2);
    lengthInput.max = normalizeDecimal(maxLength * MM_PER_METER, 2);
    widthInput.min = normalizeDecimal(minWidth * MM_PER_METER, 2);
    widthInput.max = normalizeDecimal(maxWidth * MM_PER_METER, 2);

    const currency = root.dataset.currency || "USD";
    const locale = root.dataset.locale || "en-US";
    const currencyFormatter = getCurrencyFormatter(locale, currency);
    const variantPrices = getVariantPrices(root);
    const variantRecords = getVariantRecords(root);
    const variantsById = new Map(variantRecords.map((variant) => [variant.id, variant]));
    const boundForms = new WeakSet();
    const boundVariantInputs = new WeakSet();
    const trackedVariantIds = new Set();
    const trackedSourceVariantIds = new Set();

    function setError(message) {
      errorOutput.textContent = message;
    }

    function updateSummary(areaValue, totalValue) {
      areaOutput.textContent = formatArea(areaValue);
      totalOutput.textContent = currencyFormatter.format(totalValue);
    }

    function getMeasurement(unitPrice) {
      const lengthMm = parseNumber(lengthInput.value);
      const widthMm = parseNumber(widthInput.value);

      if (lengthMm === null || widthMm === null) {
        return {
          valid: false,
          error: "Enter both length and width.",
        };
      }

      if (lengthMm <= 0 || widthMm <= 0) {
        return {
          valid: false,
          error: "Length and width must be greater than 0.",
        };
      }

      const length = lengthMm / MM_PER_METER;
      const width = widthMm / MM_PER_METER;

      if (length < minLength || length > maxLength) {
        const minLengthMm = round(minLength * MM_PER_METER, 2);
        const maxLengthMm = round(maxLength * MM_PER_METER, 2);
        return {
          valid: false,
          error: `Length must be between ${minLengthMm} and ${maxLengthMm} mm.`,
        };
      }

      if (width < minWidth || width > maxWidth) {
        const minWidthMm = round(minWidth * MM_PER_METER, 2);
        const maxWidthMm = round(maxWidth * MM_PER_METER, 2);
        return {
          valid: false,
          error: `Width must be between ${minWidthMm} and ${maxWidthMm} mm.`,
        };
      }

      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        return {
          valid: false,
          error: "Selected variant has no valid base price.",
        };
      }

      const area = round(length * width, 4);
      const totalPrice = round(area * unitPrice, 2);

      if (area <= 0 || totalPrice <= 0) {
        return {
          valid: false,
          error: "Computed area and total price must be greater than 0.",
        };
      }

      return {
        valid: true,
        lengthMm,
        widthMm,
        length,
        width,
        area,
        totalPrice,
      };
    }

    function syncVariantProperties(forms, measurement) {
      trackedVariantIds.forEach((variantId) => {
        SQM_PROPERTIES_BY_VARIANT.delete(variantId);
      });
      trackedVariantIds.clear();
      trackedSourceVariantIds.forEach((sourceVariantId) => {
        SQM_TARGET_VARIANT_BY_SOURCE.delete(sourceVariantId);
      });
      trackedSourceVariantIds.clear();

      if (!measurement.valid) return null;

      const properties = buildPropertiesFromMeasurement(measurement);
      forms.forEach((form) => {
        const selectedVariantId = getVariantIdFromForm(form);
        if (!selectedVariantId) return;

        trackedVariantIds.add(selectedVariantId);
        SQM_PROPERTIES_BY_VARIANT.set(selectedVariantId, properties);

        const pricingVariantId = resolvePricingVariantId(
          selectedVariantId,
          measurement.totalPrice,
          measurement.area,
          variantRecords,
          variantsById,
        );

        if (pricingVariantId && pricingVariantId !== selectedVariantId) {
          trackedSourceVariantIds.add(selectedVariantId);
          SQM_TARGET_VARIANT_BY_SOURCE.set(selectedVariantId, pricingVariantId);

          trackedVariantIds.add(pricingVariantId);
          SQM_PROPERTIES_BY_VARIANT.set(pricingVariantId, properties);
        }
      });

      return properties;
    }

    function bindFormValidation(form) {
      if (boundForms.has(form)) return;
      boundForms.add(form);

      form.addEventListener("submit", (event) => {
        const forms = findProductForms(root);
        const unitPrice = getActiveUnitPrice(forms, fallbackUnitPrice, variantPrices);
        const measurement = getMeasurement(unitPrice);

        if (!measurement.valid) {
          event.preventDefault();
          setError(measurement.error);
          return;
        }

        setError("");
        const properties = buildPropertiesFromMeasurement(measurement);
        const selectedVariantId = getVariantIdFromForm(form);
        const pricingVariantId = resolvePricingVariantId(
          selectedVariantId,
          measurement.totalPrice,
          measurement.area,
          variantRecords,
          variantsById,
        );

        if (selectedVariantId) {
          properties[SELECTED_VARIANT_PROPERTY_KEY] = selectedVariantId;
        }

        if (
          selectedVariantId &&
          pricingVariantId &&
          pricingVariantId !== selectedVariantId
        ) {
          trackedSourceVariantIds.add(selectedVariantId);
          SQM_TARGET_VARIANT_BY_SOURCE.set(selectedVariantId, pricingVariantId);
          trackedVariantIds.add(pricingVariantId);
          SQM_PROPERTIES_BY_VARIANT.set(pricingVariantId, properties);

          const variantInput = form.querySelector('[name="id"]');
          if (variantInput) {
            const originalVariantId = String(variantInput.value || "").trim();
            variantInput.value = pricingVariantId;

            window.setTimeout(() => {
              if (String(variantInput.value || "").trim() === pricingVariantId) {
                variantInput.value = originalVariantId || selectedVariantId;
              }
            }, 750);
          }
        }

        properties[SQM_UID_PROPERTY_KEY] = generateSqmUid();
        applyPropertiesToForm(form, properties);
      });
    }

    function bindVariantChangeRefresh(form, refresh) {
      const variantInputs = form.querySelectorAll('[name="id"]');
      variantInputs.forEach((variantInput) => {
        if (boundVariantInputs.has(variantInput)) return;
        boundVariantInputs.add(variantInput);
        variantInput.addEventListener("change", refresh);
        variantInput.addEventListener("input", refresh);
      });
    }

    function refresh() {
      const forms = findProductForms(root);
      const unitPrice = getActiveUnitPrice(forms, fallbackUnitPrice, variantPrices);
      const measurement = getMeasurement(unitPrice);

      if (!measurement.valid) {
        setError(measurement.error);
        updateSummary(0, 0);
      } else {
        setError("");
        updateSummary(measurement.area, measurement.totalPrice);
      }

      const properties = syncVariantProperties(forms, measurement);

      forms.forEach((form) => {
        bindFormValidation(form);
        bindVariantChangeRefresh(form, refresh);
        if (properties) {
          applyPropertiesToForm(form, properties);
        }
      });
    }

    lengthInput.addEventListener("input", refresh);
    widthInput.addEventListener("input", refresh);
    refresh();
  }

  function initializeBlocks() {
    installCartRequestHooks();
    document.querySelectorAll(BLOCK_SELECTOR).forEach((element) => {
      initializeBlock(element);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeBlocks);
  } else {
    initializeBlocks();
  }

  document.addEventListener("shopify:section:load", initializeBlocks);
})();
