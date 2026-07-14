<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

namespace OCA\Mail\Service\HtmlPurify;

use HTMLPurifier_AttrTransform;
use HTMLPurifier_Config;
use HTMLPurifier_Context;

/**
 * Converts the legacy, presentational `background` HTML attribute --
 * still used by some commercial email templates on <table>/<td>/<body>
 * for maximum client compatibility, predating CSS background-image -- into
 * an equivalent `style="background-image:url(...)"` declaration, the form
 * TransformStyleURLs already knows how to detect and block/proxy.
 *
 * Runs as a PRE transform (before attribute validation), same stage
 * HTMLPurifier's own bundled Tidy module has an equivalent transform for
 * this exact attribute at (HTMLPurifier_AttrTransform_Background) -- not
 * used directly here since Tidy mode isn't enabled in this app's config
 * (HTML.TidyLevel is never set) and pulling in just this one transform
 * from a module meant to be enabled as a whole would be more fragile than
 * a small, explicit, independently-tested equivalent living alongside
 * every other transform this app already maintains for the same purpose.
 *
 * Without this, a background="http://..." image on those elements sailed
 * straight through completely unblocked: TransformImageSrc only ever
 * looks at <img> tags, and TransformStyleURLs only ever looks at an
 * EXISTING `style` attribute -- neither one ever saw `background` at all,
 * so the "Show images" privacy gate silently never applied to any
 * template using this pattern instead of a plain <img> or a CSS
 * background-image declaration.
 */
class TransformBackgroundAttr extends HTMLPurifier_AttrTransform {
	/**
	 * @param array $attr
	 * @param HTMLPurifier_Config $config
	 * @param HTMLPurifier_Context $context
	 * @return array
	 */
	#[\Override]
	public function transform($attr, $config, $context) {
		if (!isset($attr['background'])) {
			return $attr;
		}

		$background = $this->confiscateAttr($attr, 'background');
		$this->prependCSS($attr, 'background-image:url(' . $background . ');');
		return $attr;
	}
}
