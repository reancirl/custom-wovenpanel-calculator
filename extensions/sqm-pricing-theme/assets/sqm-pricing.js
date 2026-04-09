(function () {
  "use strict";

  const BLOCK_SELECTOR = "[data-sqm-pricing]";
  const LENGTH_INPUT_SELECTOR = "[data-sqm-length]";
  const WIDTH_INPUT_SELECTOR = "[data-sqm-width]";
  const AREA_OUTPUT_SELECTOR = "[data-sqm-area]";
  const TOTAL_OUTPUT_SELECTOR = "[data-sqm-total]";
  const ERROR_OUTPUT_SELECTOR = "[data-sqm-error]";
  const VARIANT_PRICES_SELECTOR = "[data-sqm-variant-prices]";

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

  function getSelectedVariantId(forms) {
    for (const form of forms) {
      const variantInput = form.querySelector('[name="id"]');
      if (!variantInput) continue;

      const variantId = variantInput.value ? String(variantInput.value) : "";
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

    lengthInput.min = normalizeDecimal(minLength, 4);
    lengthInput.max = normalizeDecimal(maxLength, 4);
    widthInput.min = normalizeDecimal(minWidth, 4);
    widthInput.max = normalizeDecimal(maxWidth, 4);

    const currency = root.dataset.currency || "USD";
    const locale = root.dataset.locale || "en-US";
    const currencyFormatter = getCurrencyFormatter(locale, currency);
    const variantPrices = getVariantPrices(root);
    const boundForms = new WeakSet();
    const boundVariantInputs = new WeakSet();

    function setError(message) {
      errorOutput.textContent = message;
    }

    function updateSummary(areaValue, totalValue) {
      areaOutput.textContent = formatArea(areaValue);
      totalOutput.textContent = currencyFormatter.format(totalValue);
    }

    function getMeasurement(unitPrice) {
      const length = parseNumber(lengthInput.value);
      const width = parseNumber(widthInput.value);

      if (length === null || width === null) {
        return {
          valid: false,
          error: "Enter both length and width.",
        };
      }

      if (length <= 0 || width <= 0) {
        return {
          valid: false,
          error: "Length and width must be greater than 0.",
        };
      }

      if (length < minLength || length > maxLength) {
        return {
          valid: false,
          error: `Length must be between ${minLength} and ${maxLength} meters.`,
        };
      }

      if (width < minWidth || width > maxWidth) {
        return {
          valid: false,
          error: `Width must be between ${minWidth} and ${maxWidth} meters.`,
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
        length,
        width,
        area,
        totalPrice,
      };
    }

    function applyPropertiesToForm(form, measurement) {
      upsertHiddenInput(form, "properties[length]", formatArea(measurement.length));
      upsertHiddenInput(form, "properties[width]", formatArea(measurement.width));
      upsertHiddenInput(form, "properties[area]", formatArea(measurement.area));
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
        applyPropertiesToForm(form, measurement);
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

      forms.forEach((form) => {
        bindFormValidation(form);
        bindVariantChangeRefresh(form, refresh);
        if (measurement.valid) {
          applyPropertiesToForm(form, measurement);
        }
      });
    }

    lengthInput.addEventListener("input", refresh);
    widthInput.addEventListener("input", refresh);
    refresh();
  }

  function initializeBlocks() {
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
