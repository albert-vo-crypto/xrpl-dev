import scrapy
from ..items import SampletestItem #items class

class QuoteTestSpider(scrapy.Spider):
    name = 'quote_test'
    start_urls = ['https://quotes.toscrape.com/']

    def parse(self, response):
        items = SampletestItem() #items class
        quotes = response.css("div.quote")
        for quote in quotes:
            items['title'] = quote.css("span.text::text").get()
            items['author'] = quote.css(".author::text").get()
            items['tags'] = quote.css(".tags .tag::text").getall()
            
            yield items
            next_page = response.css(".next a::attr(href)").get()
            if next_page is not None:
                next_url = response.urljoin(next_page)
                yield scrapy.Request(next_url, callback=self.parse)