<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service\HtmlPurify;

use ChristophWurst\Nextcloud\Testing\TestCase;
use HTMLPurifier_Config;
use HTMLPurifier_Context;
use OCA\Mail\Service\HtmlPurify\TransformBackgroundAttr;

class TransformBackgroundAttrTest extends TestCase {
	private TransformBackgroundAttr $transform;

	protected function setUp(): void {
		parent::setUp();
		$this->transform = new TransformBackgroundAttr();
	}

	public function testNoBackgroundAttributeUnchanged(): void {
		$attr = ['class' => 'container'];
		$config = HTMLPurifier_Config::createDefault();
		$context = new HTMLPurifier_Context();

		$result = $this->transform->transform($attr, $config, $context);

		$this->assertSame($attr, $result);
	}

	public function testConvertsBackgroundAttributeToStyle(): void {
		$attr = ['background' => 'http://example.com/track.png'];
		$config = HTMLPurifier_Config::createDefault();
		$context = new HTMLPurifier_Context();

		$result = $this->transform->transform($attr, $config, $context);

		$this->assertArrayNotHasKey('background', $result);
		$this->assertSame('background-image:url(http://example.com/track.png);', $result['style']);
	}

	public function testPrependsToAnExistingStyleAttributeRatherThanOverwritingIt(): void {
		$attr = [
			'background' => 'http://example.com/track.png',
			'style' => 'padding: 10px;',
		];
		$config = HTMLPurifier_Config::createDefault();
		$context = new HTMLPurifier_Context();

		$result = $this->transform->transform($attr, $config, $context);

		$this->assertSame('background-image:url(http://example.com/track.png);padding: 10px;', $result['style']);
	}
}
