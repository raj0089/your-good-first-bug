const sequelize = require('sequelize');
const models = require('./models');

function parseQueryString(qs) {
  if (!qs) {
    return {};
  } else {
    let queries;
    try {
      queries = JSON.parse(qs);
    } catch (err) {
      console.error('Fail to parse query string with JSON: ', qs);
      queries = {};
    }
    return queries;
  }
}

function buildComparedQuery(query, transformer = undefined) {
  // the qs should be JSON-string, containing a tree
  // which contains following field:
  // {
  //   operator: string, including '>', '<', '>=', '<=', '&', '|'...
  //   value: the value we want to compared, can be a number, string or query type.
  // }
  // If the `transformer` argument is given, the JSON-parsed
  // value will be passed to get the value to compared.
  const comparatorMap = {
    '>': (value) => ({
      $gt: value,
    }),
    '>=': (value) => ({
      $gte: value,
    }),
    '<': (value) => ({
      $lt: value,
    }),
    '<=': (value) => ({
      $lte: value,
    }),
    '=': (value) => ({
      $eq: value,
    }),
    '!=': (value) => ({
      $ne: value,
    }),
    '&': (value) => ({
      $and: value.reduce(
        (q, childQ) => Object.assign(q, buildComparedQuery(childQ, transformer)),
        {}
      ),
    }),
    '|': (value) => ({
      $or: value.reduce(
        (q, childQ) => Object.assign(q, buildComparedQuery(childQ, transformer)),
        {}
      ),
    }),
  };
  const comparator = comparatorMap[query.operator];
  if (comparator === undefined) {
    console.log('Fail to parse comparator with operator: ', query.operator);
    console.log('Just don\'t put it into WHERE query.');
    return {};
  }
  let value;
  try {
    value = transformer ? transformer(query.value) : query.value;
  }
  catch (err) {
    console.error('Fail to transform value: ', query, ' with transformer: ', transformer);
    return {};
  }
  return comparator(value);
}

function buildComparedQueryFromRawQS(qs) {
  const queries = parseQueryString(qs);
  return buildComparedQuery(queries);
}

function buildPaginatedQuery(query, page, limit) {
  return Object.assign(query, {
    limit,
    offset: (page - 1) * limit,
  });
}

function buildQuery(rawQuery) {
  const queryBuilders = {
    language: (q, language) => {
      const newQuery = Object.assign({}, q);
      const includedLanguage = {
        model: models.Language,
        where: { name: language },
        attributes: ['name'],
      };
      let hasIncludedProject = false;
      const includeLength = newQuery.include.length;
      for (let i = 0; i < includeLength; i++) {
        const includedModel = newQuery.include[i];
        if (includedModel.model === models.Project) {
          hasIncludedProject = true;
          if (includedModel.include !== undefined) {
            for (const j in includedModel.include) {
              if (includedModel.include[j].model === models.Language) {
                includedModel.include[j] = includedLanguage;
              }
            }
          } else {
            newQuery.include[i].include = [includedLanguage];
          }
        }
      }
      if (!hasIncludedProject) {
        newQuery.include.push({
          model: models.Project,
          attributes: ['name'],
          include: [includedLanguage],
        });
      }
      return newQuery;
    },
    projectSize: (q, projectSize) => {
      const newQuery = Object.assign({}, q);
      let hasIncludedProject = false;
      const includeLength = newQuery.include.length;
      for (let i = 0; i < includeLength; i++) {
        const includedModel = newQuery.include[i];
        if (includedModel.model === models.Project) {
          hasIncludedProject = true;
          includedModel.where = includedModel.where ? includedModel.where : {};
          includedModel.where.size = buildComparedQueryFromRawQS(projectSize);
        }
      }
      if (!hasIncludedProject) {
        newQuery.include.push({
          model: models.Project,
          attributes: ['name', 'url', 'description', 'size'],
          where: {
            size: buildComparedQueryFromRawQS(projectSize),
          },
        });
      }
      return newQuery;
    },
    createdAt: (q, createdAt) => {
      const newQuery = Object.assign({}, q);
      newQuery.where.createdAt = buildComparedQueryFromRawQS(createdAt);
      return newQuery;
    },
    sortBy: (q, sortBy) => {
      const newQuery = Object.assign({}, q);
      const sortingDirection = q.order[0][q.order[0].length - 1];
      // project popularity, project size, createdAt
      const sortingMap = {
        createdAt: ['createdAt'],
        popularity: [models.Project, 'popularity'],
        projectSize: [models.Project, 'size'],
      };
      newQuery.order = sortingMap[sortBy] ? [[...sortingMap[sortBy], sortingDirection]] : q.order;
      return newQuery;
    },
    order: (q, order) => {
      const newQuery = Object.assign({}, q);
      const orderMap = {
        ascendant: 'ASC',
        descendant: 'DESC',
      };
      const newOrder = orderMap[order] ? orderMap[order] : 'DESC';
      newQuery.order = newQuery.order.map(
        (sortingOpt) => [...sortingOpt.slice(0, sortingOpt.length - 1), newOrder]
      );
      return newQuery;
    },
  };
  const query = {
    include: [
      {
        model: models.Project,
        attributes: ['name', 'url', 'description', 'size'],
        include: [
          {
            model: models.Language,
            attributes: ['name'],
          },
        ],
      },
    ],
    where: {},
    order: [['createdAt', 'DESC']],
  };
  return Object.keys(queryBuilders).reduce((newQuery, option) => {
    if (rawQuery[option] !== undefined) {
      return queryBuilders[option](newQuery, rawQuery[option]);
    } else {
      return newQuery;
    }
  }, query);
}

function queryIssues(rawQuery, page = 1, limit = 100) {
  console.log('Receive rawQuery: ', rawQuery);
  const query = buildQuery(rawQuery);
  const paginatedQuery = buildPaginatedQuery(query, page, limit);
  console.log('Build query: ', paginatedQuery, paginatedQuery.include[0].where);
  return models.Issue.findAndCountAll(paginatedQuery)
  .catch((err) => { throw err; })
  .then(
    (issuesAndCount) => {
      const data = issuesAndCount.rows;
      const dataTotal = issuesAndCount.count;
      const pageTotal = Math.floor(dataTotal / 100) + (dataTotal % 100 === 0 ? 0 : 1);
      if (pageTotal < page) {
        throw Error(`Page ${page} larger than total page: ${pageTotal}`);
      }
      return {
        pageTotal,
        dataTotal,
        data,
      };
    }
  );
}

const queryDistinctLanguages = () => {
  return models.Language.aggregate('name', 'DISTINCT', { plain: false })
  .then((cols) =>
    cols.filter(col => !!col.DISTINCT)
    .map(col => ({ value: col.DISTINCT }))
  );
};

const getMaxProjectSize = () => models.Project.getMaxProjectSize;

module.exports = {
  queryIssues,
  queryDistinctLanguages,
  getMaxProjectSize,
};
