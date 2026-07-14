<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2016-2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-FileCopyrightText: 2016 ownCloud, Inc.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

namespace OCA\Mail\Service\HtmlPurify;

use HTMLPurifier_Config;
use HTMLPurifier_Context;
use HTMLPurifier_URI;
use HTMLPurifier_URIFilter;
use HTMLPurifier_URIParser;
use OCA\Mail\Html\ProxyHmacGenerator;
use OCP\IRequest;
use OCP\IURLGenerator;

class TransformURLScheme extends HTMLPurifier_URIFilter {
	public function __construct(
		private int $messageId,
		private array $inlineAttachments,
		private IURLGenerator $urlGenerator,
		private IRequest $request,
		private ProxyHmacGenerator $hmacGenerator,
	) {
		$this->name = 'TransformURLScheme';
		$this->post = true;
	}

	/**
	 * Transformator which will rewrite all HTTPS and HTTP urls to
	 *
	 * @param \HTMLPurifier_URI $uri
	 * @param HTMLPurifier_Config $config
	 * @param HTMLPurifier_Context $context
	 * @return bool
	 */
	#[\Override]
	public function filter(&$uri, $config, $context) {
		if ($uri->scheme === null) {
			$uri->scheme = 'https';
		}

		// Only HTTPS and HTTP urls should get rewritten
		if ($uri->scheme === 'https' || $uri->scheme === 'http' || $uri->scheme === 'ftp') {
			$uri = $this->filterHttpFtp($uri, $context);
		}

		if ($uri->scheme === 'cid') {
			$uri = $this->replaceCidWithUrl($uri);
		}

		return true;
	}

	private function filterHttpFtp(HTMLPurifier_URI $uri, HTMLPurifier_Context $context): HTMLPurifier_URI {
		$originalURL = $uri->scheme . '://' . $uri->host;

		// Add the port if it's not a default port
		if ($uri->port !== null
			&& !($uri->scheme === 'http' && $uri->port === 80)
			&& !($uri->scheme === 'https' && $uri->port === 443)
			&& !($uri->scheme === 'ftp' && $uri->port === 21)) {
			$originalURL = $originalURL . ':' . $uri->port;
		}

		$originalURL = $originalURL . $uri->path;

		if ($uri->query !== null) {
			$originalURL = $originalURL . '?' . $uri->query;
		}
		if ($uri->fragment !== null) {
			$originalURL = $originalURL . '#' . $uri->fragment;
		}

		// Get the HTML attribute
		$element = $context->exists('CurrentAttr') ? $context->get('CurrentAttr') : null;

		// If element is of type "href" it is most likely a link that should get redirected
		// otherwise it's an element that we send through our proxy
		if ($element === 'href') {
			return $uri;
		}

		$proxyUrl = $this->urlGenerator->linkToRoute('mail.proxy.proxy', [
			'id' => $this->messageId,
			'hmac' => $this->hmacGenerator->generate($this->messageId, $originalURL),
			'src' => $originalURL
		]);
		$parsedProxyUrl = parse_url($proxyUrl);
		/** @var array{path: string, query?: string} $parsedProxyUrl */
		return new \HTMLPurifier_URI(
			$this->request->getServerProtocol(),
			null, $this->request->getServerHost(),
			null,
			$parsedProxyUrl['path'],
			// parse_url() only includes 'query' at all when the URL
			// actually has one -- in normal use mail.proxy.proxy always
			// gets id/hmac/src as query params, so this never mattered in
			// practice, but assuming the key unconditionally exists is
			// still one query-string-shape assumption too many for a
			// value we don't control the construction of ourselves.
			$parsedProxyUrl['query'] ?? null,
			null
		);
	}

	private function replaceCidWithUrl(HTMLPurifier_URI $uri): HTMLPurifier_URI {
		$inlineAttachment = array_find($this->inlineAttachments, static fn ($attachment) => $attachment['cid'] === $uri->path);

		if ($inlineAttachment === null) {
			return $uri;
		}

		return (new HTMLPurifier_URIParser())->parse($inlineAttachment['url']);
	}
}
