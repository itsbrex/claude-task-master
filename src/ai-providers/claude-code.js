/**
 * src/ai-providers/claude-code.js
 *
 * Implementation for interacting with Claude Code CLI
 * This provider uses the local Claude Code CLI instead of direct API calls,
 * allowing users to leverage their flat subscription.
 */
import { spawn } from 'node:child_process';
import { log } from '../../scripts/modules/utils.js';
import { BaseAIProvider } from './base-provider.js';

/**
 * Claude Code CLI Provider Class
 */
export class ClaudeCodeAIProvider extends BaseAIProvider {
	constructor() {
		super();
		this.name = 'ClaudeCodeAIProvider';
	}

	/**
	 * Override auth validation - Claude Code CLI doesn't need API keys
	 */
	validateAuth(params) {
		// Claude Code CLI uses local authentication, no API key needed
		return true;
	}

	/**
	 * Not applicable for CLI - returns null
	 */
	getClient(params) {
		return null;
	}

	/**
	 * Formats messages array into a single prompt for Claude Code CLI
	 */
	formatMessagesForCLI(messages) {
		let prompt = '';

		// Find system and user messages
		const systemMessage = messages.find((m) => m.role === 'system');
		const userMessages = messages.filter((m) => m.role === 'user');

		// Add system prompt if exists
		if (systemMessage?.content) {
			prompt += `System: ${systemMessage.content}\n\n`;
		}

		// Add user messages
		userMessages.forEach((msg, index) => {
			if (index > 0) prompt += '\n\n';
			prompt += msg.content;
		});

		return prompt;
	}

	/**
	 * Executes Claude Code CLI with proper stdin handling
	 */
	async executeClaudeCommand(command, input, timeout = 300000) {
		return new Promise((resolve, reject) => {
			const args = command.split(' ').slice(1); // Remove 'claude' from command

			// Try different possible paths for Claude CLI
			const possiblePaths = [
				'claude', // Standard PATH
				'/Users/hack/.claude/local/claude', // User-specific installation
				'/usr/local/bin/claude', // Global installation
				`${process.env.HOME}/.claude/local/claude` // Dynamic home path
			];

			let claudePath = 'claude'; // Default

			// If we can detect the home directory, try the local installation first
			if (process.env.HOME) {
				claudePath = `${process.env.HOME}/.claude/local/claude`;
			}

			log('debug', `Attempting to execute Claude CLI at path: ${claudePath}`);

			const child = spawn(claudePath, args, {
				stdio: ['pipe', 'pipe', 'pipe'],
				encoding: 'utf8'
			});

			let stdout = '';
			let stderr = '';
			let isResolved = false;

			// Set up timeout
			const timeoutId = setTimeout(() => {
				if (!isResolved) {
					isResolved = true;
					child.kill('SIGTERM');
					reject(new Error(`Claude Code CLI timed out after ${timeout}ms`));
				}
			}, timeout);

			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');

			child.stdout.on('data', (data) => {
				stdout += data;
			});

			child.stderr.on('data', (data) => {
				stderr += data;
			});

			child.on('error', (error) => {
				if (!isResolved) {
					isResolved = true;
					clearTimeout(timeoutId);

					// If the specific path failed, try falling back to 'claude' in PATH
					if (error.code === 'ENOENT' && claudePath !== 'claude') {
						log(
							'debug',
							`Claude path ${claudePath} not found, trying 'claude' in PATH`
						);
						// Retry with just 'claude'
						this.executeClaudeCommand(command, input, timeout)
							.then(resolve)
							.catch(reject);
						return;
					}

					reject(error);
				}
			});

			child.on('close', (code) => {
				if (!isResolved) {
					isResolved = true;
					clearTimeout(timeoutId);

					if (code !== 0) {
						reject(
							new Error(`Claude Code CLI exited with code ${code}: ${stderr}`)
						);
					} else {
						resolve({ stdout, stderr });
					}
				}
			});

			// Write input to stdin
			child.stdin.setEncoding('utf8');
			child.stdin.write(input);
			child.stdin.end();
		});
	}

	/**
	 * Generates text using Claude Code CLI
	 */
	async generateText(params) {
		try {
			this.validateParams(params);
			this.validateMessages(params.messages);

			log(
				'debug',
				`Generating Claude Code text with model preference: ${params.modelId}`
			);

			// Format messages into a single prompt
			const prompt = this.formatMessagesForCLI(params.messages);

			// Check for very long prompts that might cause issues
			if (prompt.length > 100000) {
				log(
					'warn',
					`Very long prompt detected (${prompt.length} chars). This might cause issues with Claude Code CLI.`
				);
			}

			// Build the command with model selection if applicable
			let command = 'claude --print --output-format json';

			// Map common model IDs to Claude Code CLI model aliases
			if (params.modelId && params.modelId !== 'default') {
				const modelMap = {
					'claude-3-opus-20240229': 'opus',
					'claude-3-5-sonnet-20241022': 'sonnet',
					'claude-3-5-haiku-20241022': 'haiku',
					'claude-sonnet-4-20250514': 'sonnet',
					'claude-3-7-sonnet-20250219': 'sonnet'
				};

				const modelAlias = modelMap[params.modelId] || params.modelId;
				command += ` --model ${modelAlias}`;
			}

			log('debug', `Executing Claude Code CLI command: ${command}`);
			log(
				'debug',
				`Executing Claude Code CLI with prompt length: ${prompt.length} chars`
			);

			// Execute the command using stdin to avoid shell escaping issues
			const { stdout, stderr } = await this.executeClaudeCommand(
				command,
				prompt
			);

			if (stderr) {
				log('warn', `Claude Code CLI stderr: ${stderr}`);
			}

			// Log the response length for debugging
			log(
				'debug',
				`Claude Code CLI stdout length: ${stdout.length} characters`
			);

			// Check if stdout looks truncated or malformed
			if (stdout.length === 0) {
				throw new Error('Claude Code CLI returned empty response');
			}

			// Check for common CLI error patterns
			if (stdout.includes('Error:') || stdout.includes('error:')) {
				log(
					'error',
					`Claude Code CLI reported an error in stdout: ${stdout.substring(0, 500)}`
				);
				throw new Error(
					`Claude Code CLI error detected in output: ${stdout.substring(0, 200)}`
				);
			}

			// Parse the JSON response with better error handling
			let response;
			try {
				response = JSON.parse(stdout);
			} catch (parseError) {
				log(
					'error',
					`Failed to parse Claude Code CLI JSON response: ${parseError.message}`
				);
				log(
					'debug',
					`Raw stdout (first 500 chars): ${stdout.substring(0, 500)}`
				);
				log(
					'debug',
					`Raw stdout (last 500 chars): ${stdout.substring(Math.max(0, stdout.length - 500))}`
				);

				// Check if response appears truncated (doesn't end with closing brace)
				const trimmedOutput = stdout.trim();
				if (!trimmedOutput.endsWith('}')) {
					log(
						'error',
						"Response appears to be truncated - doesn't end with closing brace"
					);
					throw new Error(
						'Claude Code CLI response appears to be truncated. Try reducing the size of your PRD or breaking it into smaller sections.'
					);
				}

				// Try to find if there's a JSON object in the response
				const jsonMatch = stdout.match(/\{[\s\S]*\}/);
				if (jsonMatch) {
					try {
						response = JSON.parse(jsonMatch[0]);
						log(
							'debug',
							'Successfully extracted JSON from response using regex'
						);
					} catch (regexParseError) {
						throw new Error(
							`Claude Code CLI returned malformed JSON: ${parseError.message}`
						);
					}
				} else {
					throw new Error(
						`Claude Code CLI response is not valid JSON: ${parseError.message}`
					);
				}
			}

			if (response.is_error) {
				throw new Error(
					`Claude Code CLI error: ${response.error || 'Unknown error'}`
				);
			}

			log(
				'debug',
				`Claude Code CLI response received. Cost: $${response.cost_usd || 0}`
			);

			// Return in the expected format
			return {
				text: response.result || '',
				usage: {
					// CLI doesn't provide token counts, so we estimate or use defaults
					inputTokens: 0,
					outputTokens: 0,
					totalTokens: 0,
					// Include cost information if available
					costUSD: response.cost_usd || 0
				}
			};
		} catch (error) {
			if (error.code === 'ENOENT') {
				log(
					'error',
					'Claude Code CLI not found. Please ensure it is installed and in PATH.'
				);
				throw new Error(
					'Claude Code CLI not found. Please install it first: npm install -g @anthropic-ai/claude-code'
				);
			}

			this.handleError('text generation', error);
		}
	}

	/**
	 * Streams text using Claude Code CLI
	 * Note: CLI doesn't support streaming, so this falls back to regular generation
	 */
	async streamText(params) {
		log(
			'debug',
			'Claude Code CLI does not support streaming. Using regular generation.'
		);

		// Fall back to regular generation
		const result = await this.generateText(params);

		// Simulate a stream-like response structure
		return {
			textStream: {
				// Create an async iterator that yields the full text at once
				async *[Symbol.asyncIterator]() {
					yield result.text;
				}
			},
			usage: Promise.resolve(result.usage),
			text: result.text
		};
	}

	/**
	 * Generates an object using Claude Code CLI
	 */
	async generateObject(params) {
		try {
			this.validateParams(params);
			this.validateMessages(params.messages);

			if (!params.schema) {
				throw new Error('Schema is required for object generation');
			}

			log(
				'debug',
				`Generating Claude Code object with model preference: ${params.modelId}`
			);

			// Add schema instructions to the system message
			const schemaInstructions = `You must respond with a valid JSON object that matches this schema: ${JSON.stringify(params.schema)}`;

			// Modify messages to include schema instructions
			const modifiedMessages = [...params.messages];
			const systemMessage = modifiedMessages.find((m) => m.role === 'system');

			if (systemMessage) {
				systemMessage.content += `\n\n${schemaInstructions}`;
			} else {
				modifiedMessages.unshift({
					role: 'system',
					content: schemaInstructions
				});
			}

			// Use generateText with modified messages
			const textResult = await this.generateText({
				...params,
				messages: modifiedMessages
			});

			// Parse the response as JSON
			let parsedObject;
			try {
				parsedObject = JSON.parse(textResult.text);
			} catch (parseError) {
				throw new Error(
					`Failed to parse Claude Code CLI response as JSON: ${parseError.message}`
				);
			}

			return {
				object: parsedObject,
				usage: textResult.usage
			};
		} catch (error) {
			this.handleError('object generation', error);
		}
	}
}
