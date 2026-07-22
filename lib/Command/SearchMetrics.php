<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Command;

use OCA\Mail\Service\Search\SearchTelemetry;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use function json_encode;
use function sprintf;

final class SearchMetrics extends Command {
	public function __construct(
		private SearchTelemetry $telemetry,
	) {
		parent::__construct();
	}

	protected function configure(): void {
		$this->setName('mail:search:metrics');
		$this->setDescription('Show PII-safe free-text search latency histograms from the distributed cache');
		$this->addOption('days', null, InputOption::VALUE_REQUIRED, 'Reporting horizon (1-8 days)', '7');
		$this->addOption('json', null, InputOption::VALUE_NONE, 'Emit machine-readable JSON');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$days = (int)$input->getOption('days');
		if ($days < 1 || $days > 8) {
			$output->writeln('<error>--days must be between 1 and 8</error>');
			return 1;
		}
		$rows = $this->telemetry->summarize($days);
		if ($input->getOption('json')) {
			$output->writeln(json_encode($rows, JSON_THROW_ON_ERROR));
			return 0;
		}
		if ($rows === []) {
			$output->writeln('No Mail free-text search metrics are available for this horizon.');
			return 0;
		}

		$output->writeln('Percentiles are conservative histogram upper bounds in milliseconds.');
		$output->writeln('window             shape                 backend                    split  count  err  slow  p50  p95  p99  avg     results terms');
		foreach ($rows as $row) {
			$output->writeln(sprintf(
				'%-18s %-21s %-26s %-6s %6d %4d %5d %4d %4d %4d %7.1f %7.1f %5.1f',
				$row['windowClass'],
				$row['queryShape'],
				$row['backend'],
				$row['prioritySplit'] ? 'yes' : 'no',
				$row['count'],
				$row['errors'],
				$row['slow'],
				$row['p50UpperMs'],
				$row['p95UpperMs'],
				$row['p99UpperMs'],
				$row['avgMs'],
				$row['avgResults'],
				$row['avgTerms'],
			));
		}
		return 0;
	}
}
