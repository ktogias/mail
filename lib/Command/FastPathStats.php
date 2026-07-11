<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Command;

use OCA\Mail\Service\Sync\SyncFastPathStats;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

final class FastPathStats extends Command {
	private const OPTION_RESET = 'reset';

	public function __construct(
		private SyncFastPathStats $stats,
	) {
		parent::__construct();
	}

	protected function configure(): void {
		$this->setName('mail:sync:fastpath-stats');
		$this->setDescription('Show the STATUS fast path\'s hit rate per sync phase (see ImapToDbSynchronizer::pruneSyncCriteria)');
		$this->addOption(self::OPTION_RESET, null, InputOption::VALUE_NONE, 'Reset all counters back to zero and exit');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		if ($input->getOption(self::OPTION_RESET)) {
			$this->stats->reset();
			$output->writeln('Counters reset.');
			return 0;
		}

		$stats = $this->stats->getStats();

		$output->writeln('STATUS fast-path hit rate per phase (pruned / attempted):');
		foreach (['new', 'flags', 'vanished'] as $phase) {
			$entry = $stats[$phase];
			$rate = $entry['hit_rate'] === null ? 'n/a' : $entry['hit_rate'] . '%';
			$output->writeln(sprintf('  %-10s %6d / %-6d  %s', $phase, $entry['pruned'], $entry['attempted'], $rate));
		}
		$output->writeln(sprintf('STATUS round trip unusable (failed or missing data): %d', $stats['status_unusable']));
		$output->writeln('');
		$output->writeln('Counters are process-local (APCu) since the last reset or PHP-FPM restart; run with --reset to start a fresh measurement window.');

		return 0;
	}
}
