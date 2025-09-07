#!/usr/bin/env node

const { Command } = require('commander');
const fs = require('fs').promises;
const path = require('path');
const glob = require('glob');
const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const RequirementsSearchEngine = require('./RequirementsSearchEngine');

class RequirementsCLI {
  constructor() {
    this.program = new Command();
    this.searchEngine = null;
    this.setupCommands();
  }

  setupCommands() {
    this.program
      .name('requirements-search')
      .description('Natural language search tool for business requirements documents')
      .version('1.0.0');

    // Index command
    this.program
      .command('index')
      .description('Index documents from a directory')
      .option('-d, --directory <path>', 'Directory to scan for documents', './docs')
      .option('-r, --recursive', 'Scan subdirectories recursively', false)
      .option('-i, --index-path <path>', 'Path for vector index storage', './requirements-index')
      .option('-f, --file-types <types>', 'Comma-separated file extensions', 'pdf,docx,xlsx,xls,txt,md')
      .option('--clear', 'Clear existing index before indexing', false)
      .option('--dry-run', 'Show files that would be indexed without processing', false)
      .option('-y, --yes', 'Skip confirmation prompts', false)
      .action(this.indexCommand.bind(this));

    // Search command
    this.program
      .command('search')
      .description('Search indexed documents')
      .argument('<query>', 'Search query')
      .option('-i, --index-path <path>', 'Path to vector index', './requirements-index')
      .option('-n, --num-results <number>', 'Number of results to return', '5')
      .option('-j, --json', 'Output results in JSON format', false)
      .action(this.searchCommand.bind(this));

    // Interactive mode
    this.program
      .command('interactive')
      .description('Start interactive search session')
      .option('-i, --index-path <path>', 'Path to vector index', './requirements-index')
      .action(this.interactiveCommand.bind(this));

    // Status command
    this.program
      .command('status')
      .description('Show index statistics')
      .option('-i, --index-path <path>', 'Path to vector index', './requirements-index')
      .action(this.statusCommand.bind(this));

    // Clear command
    this.program
      .command('clear')
      .description('Clear the vector index')
      .option('-i, --index-path <path>', 'Path to vector index', './requirements-index')
      .option('-y, --yes', 'Skip confirmation prompt', false)
      .action(this.clearCommand.bind(this));

    // Backup command
    this.program
      .command('backup')
      .description('Create a backup of the current index')
      .option('-i, --index-path <path>', 'Path to vector index', './requirements-index')
      .option('-o, --output <path>', 'Backup output path')
      .action(this.backupCommand.bind(this));

    // Restore command
    this.program
      .command('restore')
      .description('Restore index from backup')
      .argument('<backup-path>', 'Path to backup directory')
      .option('-i, --index-path <path>', 'Path to vector index', './requirements-index')
      .option('-y, --yes', 'Skip confirmation prompt', false)
      .action(this.restoreCommand.bind(this));
  }

  async initializeSearchEngine(indexPath) {
    if (!this.searchEngine || this.searchEngine.indexPath !== indexPath) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.log(chalk.red('❌ OPENAI_API_KEY environment variable is required'));
        console.log(chalk.yellow('Set it with: export OPENAI_API_KEY="your-api-key"'));
        process.exit(1);
      }
      this.searchEngine = new RequirementsSearchEngine(indexPath, apiKey);
    }
    return this.searchEngine;
  }

  async findDocuments(directory, recursive, fileTypes) {
    const extensions = fileTypes.split(',').map(ext => ext.trim().toLowerCase());
    const patterns = extensions.map(ext => 
      recursive ? `**/*.${ext}` : `*.${ext}`
    );
    
    const files = [];
    for (const pattern of patterns) {
      const matches = glob.sync(pattern, { 
        cwd: directory,
        absolute: true,
        nocase: true 
      });
      files.push(...matches);
    }
    
    // Remove duplicates and ensure files exist
    const uniqueFiles = [...new Set(files)];
    const existingFiles = [];
    
    for (const file of uniqueFiles) {
      try {
        const stats = await fs.stat(file);
        if (stats.isFile()) {
          existingFiles.push(file);
        }
      } catch (error) {
        // File doesn't exist or can't be accessed
      }
    }
    
    return existingFiles;
  }

  async indexCommand(options) {
    console.log(chalk.blue('📚 Requirements Document Indexer\n'));
    
    // Validate directory
    try {
      const stats = await fs.stat(options.directory);
      if (!stats.isDirectory()) {
        console.log(chalk.red(`❌ ${options.directory} is not a directory`));
        process.exit(1);
      }
    } catch (error) {
      console.log(chalk.red(`❌ Directory ${options.directory} does not exist`));
      process.exit(1);
    }

    // Find documents
    const spinner = ora('🔍 Scanning for documents...').start();
    const files = await this.findDocuments(options.directory, options.recursive, options.fileTypes);
    spinner.stop();

    if (files.length === 0) {
      console.log(chalk.yellow(`⚠️  No documents found in ${options.directory}`));
      console.log(chalk.gray(`   Supported types: ${options.fileTypes}`));
      console.log(chalk.gray(`   Recursive: ${options.recursive ? 'Yes' : 'No'}`));
      return;
    }

    console.log(chalk.green(`📄 Found ${files.length} documents:`));
    files.forEach(file => {
      const relativePath = path.relative(process.cwd(), file);
      console.log(chalk.gray(`   ${relativePath}`));
    });

    if (options.dryRun) {
      console.log(chalk.blue('\n🔍 Dry run complete - no files were indexed'));
      return;
    }

    // Confirm before processing
    if (!options.yes) {
      const { proceed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'proceed',
        message: `Proceed with indexing ${files.length} documents?`,
        default: true
      }]);

      if (!proceed) {
        console.log(chalk.yellow('📋 Indexing cancelled'));
        return;
      }
    }

    // Initialize search engine
    const searchEngine = await this.initializeSearchEngine(options.indexPath);

    // Clear index if requested
    if (options.clear) {
      const clearSpinner = ora('🗑️  Clearing existing index...').start();
      try {
        await searchEngine.clearIndex();
        clearSpinner.succeed('✅ Index cleared');
      } catch (error) {
        clearSpinner.fail('❌ Failed to clear index');
        console.log(chalk.red(error.message));
      }
    }

    // Index documents
    console.log(chalk.blue('\n🔄 Starting indexing process...\n'));
    
    let successCount = 0;
    let errorCount = 0;
    let totalChunks = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const relativePath = path.relative(process.cwd(), file);
      const progress = `[${i + 1}/${files.length}]`;
      
      const fileSpinner = ora(`${progress} Processing ${relativePath}...`).start();
      
      try {
        const result = await searchEngine.indexDocument(file);
        fileSpinner.succeed(`${progress} ✅ ${relativePath} (${result.chunksCreated} chunks)`);
        successCount++;
        totalChunks += result.chunksCreated;
      } catch (error) {
        fileSpinner.fail(`${progress} ❌ ${relativePath}`);
        console.log(chalk.red(`   Error: ${error.message}`));
        errorCount++;
      }
    }

    // Summary
    console.log(chalk.blue('\n📊 Indexing Summary:'));
    console.log(chalk.green(`   ✅ Successfully indexed: ${successCount} files`));
    console.log(chalk.green(`   📄 Total chunks created: ${totalChunks}`));
    if (errorCount > 0) {
      console.log(chalk.red(`   ❌ Failed to index: ${errorCount} files`));
    }
    console.log(chalk.gray(`   📍 Index location: ${options.indexPath}`));
  }

  async searchCommand(query, options) {
    const searchEngine = await this.initializeSearchEngine(options.indexPath);
    
    try {
      // Check if index exists
      const stats = await searchEngine.getStats();
      if (stats.totalChunks === 0) {
        console.log(chalk.red('❌ No documents in index. Run "requirements-search index" first.'));
        process.exit(1);
      }
    } catch (error) {
      console.log(chalk.red('❌ No index found. Run "requirements-search index" first.'));
      process.exit(1);
    }

    const spinner = ora(`🔍 Searching for: "${query}"`).start();
    
    try {
      const results = await searchEngine.search(query, parseInt(options.numResults));
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      this.displaySearchResults(query, results);
    } catch (error) {
      spinner.fail('❌ Search failed');
      console.log(chalk.red(error.message));
      process.exit(1);
    }
  }

  async interactiveCommand(options) {
    const searchEngine = await this.initializeSearchEngine(options.indexPath);
    
    try {
      const stats = await searchEngine.getStats();
      if (stats.totalChunks === 0) {
        console.log(chalk.red('❌ No documents in index. Run "requirements-search index" first.'));
        process.exit(1);
      }
      console.log(chalk.blue('🔍 Interactive Requirements Search'));
      console.log(chalk.gray(`📊 Index contains ${stats.totalChunks} chunks from ${stats.totalDocuments} documents\n`));
    } catch (error) {
      console.log(chalk.red('❌ No index found. Run "requirements-search index" first.'));
      process.exit(1);
    }

    await this.interactiveSearch(searchEngine);
  }

  async interactiveSearch(searchEngine) {
    while (true) {
      const { query } = await inquirer.prompt([{
        type: 'input',
        name: 'query',
        message: 'Enter search query (or "exit" to quit):',
        validate: input => input.trim().length > 0 || 'Please enter a search query'
      }]);

      if (query.toLowerCase() === 'exit') {
        console.log(chalk.blue('👋 Goodbye!'));
        break;
      }

      const spinner = ora(`🔍 Searching...`).start();
      
      try {
        const results = await searchEngine.search(query, 5);
        spinner.stop();
        this.displaySearchResults(query, results);
      } catch (error) {
        spinner.fail('❌ Search failed');
        console.log(chalk.red(error.message));
      }

      console.log(); // Add spacing between searches
    }
  }

  displaySearchResults(query, results) {
    console.log(chalk.blue(`\n🔍 Search Results for: "${query}"\n`));
    
    if (results.length === 0) {
      console.log(chalk.yellow('📭 No results found'));
      return;
    }

    results.forEach((result, index) => {
      console.log(chalk.green(`${index + 1}. ${result.fileName} (${result.relevancePercentage}% relevant)`));
      
      if (result.sheet) {
        console.log(chalk.gray(`   📊 Sheet: ${result.sheet}, Row: ${result.row}`));
      }
      
      console.log(chalk.gray(`   📄 ${result.preview}`));
      console.log(); // Add spacing between results
    });
  }

  async statusCommand(options) {
    const searchEngine = await this.initializeSearchEngine(options.indexPath);
    
    try {
      const stats = await searchEngine.getStats();
      
      console.log(chalk.blue('📊 Index Status\n'));
      console.log(chalk.green(`📍 Index Location: ${stats.indexPath}`));
      console.log(chalk.green(`📚 Total Documents: ${stats.totalDocuments}`));
      console.log(chalk.green(`📄 Total Chunks: ${stats.totalChunks}`));
      
      if (stats.documents.length > 0) {
        console.log(chalk.blue('\n📋 Indexed Documents:'));
        stats.documents.forEach((doc, index) => {
          console.log(chalk.gray(`   ${index + 1}. ${doc}`));
        });
      } else {
        console.log(chalk.yellow('\n📭 No documents indexed yet'));
      }
    } catch (error) {
      console.log(chalk.red('❌ No index found or index is corrupted'));
      console.log(chalk.gray('   Run "requirements-search index" to create an index'));
    }
  }

  async clearCommand(options) {
    if (!options.yes) {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: 'Are you sure you want to clear the index? This cannot be undone.',
        default: false
      }]);

      if (!confirm) {
        console.log(chalk.yellow('📋 Clear operation cancelled'));
        return;
      }
    }

    const searchEngine = await this.initializeSearchEngine(options.indexPath);
    const spinner = ora('🗑️  Clearing index...').start();
    
    try {
      await searchEngine.clearIndex();
      spinner.succeed('✅ Index cleared successfully');
    } catch (error) {
      spinner.fail('❌ Failed to clear index');
      console.log(chalk.red(error.message));
    }
  }

  async backupCommand(options) {
    const searchEngine = await this.initializeSearchEngine(options.indexPath);
    
    // Generate backup path if not provided
    const backupPath = options.output || `./index-backup-${Date.now()}`;
    
    const spinner = ora(`💾 Creating backup at ${backupPath}...`).start();
    
    try {
      const result = await searchEngine.backupIndex(backupPath);
      spinner.succeed(`✅ Backup created successfully`);
      
      console.log(chalk.blue('\n📊 Backup Details:'));
      console.log(chalk.green(`📍 Original: ${result.originalPath}`));
      console.log(chalk.green(`💾 Backup: ${result.backupPath}`));
      console.log(chalk.green(`🕒 Created: ${new Date(result.timestamp).toLocaleString()}`));
      
    } catch (error) {
      spinner.fail('❌ Backup failed');
      console.log(chalk.red(error.message));
    }
  }

  async restoreCommand(backupPath, options) {
    if (!options.yes) {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Restore index from ${backupPath}? This will replace the current index.`,
        default: false
      }]);

      if (!confirm) {
        console.log(chalk.yellow('📋 Restore operation cancelled'));
        return;
      }
    }

    const searchEngine = await this.initializeSearchEngine(options.indexPath);
    const spinner = ora(`🔄 Restoring index from ${backupPath}...`).start();
    
    try {
      const stats = await searchEngine.restoreIndex(backupPath);
      spinner.succeed('✅ Index restored successfully');
      
      console.log(chalk.blue('\n📊 Restored Index:'));
      console.log(chalk.green(`📚 Documents: ${stats.totalDocuments}`));
      console.log(chalk.green(`📄 Chunks: ${stats.totalChunks}`));
      
    } catch (error) {
      spinner.fail('❌ Restore failed');
      console.log(chalk.red(error.message));
    }
  }

  run() {
    this.program.parse();
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('\n❌ Unhandled Promise Rejection:'), reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error(chalk.red('\n❌ Uncaught Exception:'), error);
  process.exit(1);
});

// Export for testing
module.exports = RequirementsCLI;

// Run CLI if this file is executed directly
if (require.main === module) {
  const cli = new RequirementsCLI();
  cli.run();
}