# Requirements Vector Search

A powerful command-line tool for indexing and searching business requirements documents using natural language queries. Built with Vectra (local vector database) and OpenAI embeddings.

## Features

- 🔍 **Natural Language Search**: Find relevant information using plain English queries
- 📄 **Multiple File Formats**: Support for PDF, DOCX, XLSX, XLS, TXT, and Markdown files
- 📊 **Excel Integration**: Proper handling of Excel sheets with row and column tracking
- 🎯 **Semantic Similarity**: Uses OpenAI embeddings for intelligent content matching
- 💾 **Local Storage**: All data stays on your machine using Vectra local vector database
- 🔄 **Backup & Restore**: Easy index management with backup/restore functionality
- 📈 **Progress Tracking**: Visual feedback during indexing and search operations
- 🎛️ **Interactive Mode**: Real-time search session for exploratory queries

## Prerequisites

- Node.js 16.0.0 or higher
- OpenAI API key

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/br14/requirements-vector-search.git
cd requirements-vector-search
npm install
```

### 2. Set up Environment

```bash
# Get your OpenAI API key from https://platform.openai.com/api-keys
export OPENAI_API_KEY="your-api-key-here"
```

### 3. Index Your Documents

```bash
# Index all documents in ./docs directory
node src/cli.js index -d ./docs

# Index recursively with specific file types
node src/cli.js index -d ./requirements -r -f "pdf,docx,xlsx"
```

### 4. Search Your Documents

```bash
# Simple search
node src/cli.js search "user authentication requirements"

# Interactive search mode
node src/cli.js interactive

# Get JSON output
node src/cli.js search "data validation" -n 10 -j
```

## Commands

### Index Documents
```bash
node src/cli.js index [options]

Options:
  -d, --directory <path>    Directory to scan (default: ./docs)
  -r, --recursive          Scan subdirectories recursively
  -i, --index-path <path>  Index storage location (default: ./requirements-index)
  -f, --file-types <types> File extensions (default: pdf,docx,xlsx,xls,txt,md)
  --clear                  Clear existing index before indexing
  --dry-run               Show files without processing
  -y, --yes               Skip confirmation prompts
```

### Search Documents
```bash
node src/cli.js search <query> [options]

Options:
  -i, --index-path <path>     Path to vector index (default: ./requirements-index)
  -n, --num-results <number>  Number of results (default: 5)
  -j, --json                  Output as JSON
```

### Other Commands
```bash
# Interactive search mode
node src/cli.js interactive

# Check index status
node src/cli.js status

# Create backup
node src/cli.js backup -o ./backup-folder

# Restore from backup
node src/cli.js restore ./backup-folder

# Clear index
node src/cli.js clear
```

## Supported File Types

- **PDF** (.pdf): Extracts text content
- **Microsoft Word** (.docx): Extracts text content
- **Microsoft Excel** (.xlsx, .xls): Processes all sheets with row tracking
- **Text Files** (.txt): Direct text processing
- **Markdown** (.md): Direct text processing

## Excel File Features

The tool provides special handling for Excel files:
- Processes all sheets in a workbook
- Tracks row and column information
- Preserves sheet names and row references in search results
- Handles large spreadsheets efficiently

## Example Usage

### Business Requirements Search
```bash
# Index all requirement documents
node src/cli.js index -d ./business-requirements -r

# Search for specific functionality
node src/cli.js search "payment processing workflow"
node src/cli.js search "user role permissions"
node src/cli.js search "data retention policies"
```

### QA Testing Documentation
```bash
# Index test documentation
node src/cli.js index -d ./test-cases -r -f "xlsx,docx"

# Find test cases
node src/cli.js search "login validation test cases"
node src/cli.js search "API error handling tests"
```

## API Usage

You can also use the search engine programmatically:

```javascript
const RequirementsSearchEngine = require('./src/RequirementsSearchEngine');

async function example() {
  const engine = new RequirementsSearchEngine(
    './my-index',
    process.env.OPENAI_API_KEY
  );

  // Index a document
  await engine.indexDocument('./path/to/requirements.pdf');

  // Search
  const results = await engine.search('user authentication', 5);
  console.log(results);

  // Get statistics
  const stats = await engine.getStats();
  console.log(`Indexed ${stats.totalDocuments} documents`);
}
```

## Configuration

### Environment Variables
- `OPENAI_API_KEY`: Your OpenAI API key (required)

### Default Paths
- Index storage: `./requirements-index`
- Document directory: `./docs`

## Performance

- **Chunking**: Large documents are split into 500-word chunks with 50-word overlap
- **Rate Limiting**: Built-in delays to respect OpenAI API limits
- **Batch Processing**: Processes multiple chunks in parallel for efficiency
- **Local Storage**: All vector data stored locally for fast searches

## Troubleshooting

### Common Issues

1. **"No index found" Error**
   ```bash
   # Create an index first
   node src/cli.js index -d ./your-docs
   ```

2. **"OPENAI_API_KEY not found" Error**
   ```bash
   export OPENAI_API_KEY="your-api-key"
   ```

3. **File Processing Errors**
   - Ensure files are not password-protected
   - Check file permissions
   - Verify file formats are supported

4. **Search Returns No Results**
   - Try broader search terms
   - Check if documents were indexed successfully
   - Use `node src/cli.js status` to verify index contents

## Development

### Running Tests
```bash
npm test
npm run test:watch
```

### Linting
```bash
npm run lint
npm run lint:fix
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes
4. Add tests for new functionality
5. Run the test suite: `npm test`
6. Commit your changes: `git commit -am 'Add feature'`
7. Push to the branch: `git push origin feature-name`
8. Submit a pull request

## License

MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Vectra](https://github.com/microsoft/vectra) for local vector database
- [OpenAI](https://openai.com/) for embeddings API
- [Commander.js](https://github.com/tj/commander.js) for CLI framework

## Support

If you encounter any issues:

1. Check the troubleshooting section above
2. Search existing [GitHub issues](https://github.com/br14/requirements-vector-search/issues)
3. Create a new issue with detailed information about your problem